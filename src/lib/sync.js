/**
 * Silent Send - Cross-Browser Settings Sync
 *
 * Two sync mechanisms:
 *
 * 1. Sync Code — base64-encoded JSON snapshot for manual copy-paste between
 *    browsers (works across any browser/device combination).
 *
 * 2. browser.storage.sync — automatic sync within the same browser family
 *    (Firefox ↔ Firefox via Firefox Sync, Chrome ↔ Chrome via Google account).
 *    Data is chunked to stay within per-item size limits.
 *
 * Conflict resolution: newest `lastModified` timestamp wins.
 */

import api from './browser-polyfill.js';

// browser.storage.sync per-item limit (leave generous headroom)
const SYNC_CHUNK_SIZE = 5000;
const SYNC_KEY_PREFIX = 'ss_sync_chunk_';
const SYNC_META_KEY = 'ss_sync_meta';

const SilentSendSync = {
  // ----------------------------------------------------------------
  // Sync Code — manual cross-browser copy-paste
  // ----------------------------------------------------------------

  /**
   * Export all settings/mappings/identity as a compact base64 sync code.
   * Share this code with another browser to import.
   */
  async exportSyncCode() {
    const data = await this._getAllData();
    const json = JSON.stringify(data);
    // btoa requires ASCII; use encodeURIComponent to handle Unicode
    return btoa(unescape(encodeURIComponent(json)));
  },

  /**
   * Import from a sync code string.
   * Returns { success, importTime } or { success: false, skipped?, reason, localTime?, importTime? }
   *
   * Conflict resolution: newest timestamp wins.
   * Pass force=true to override even if local is newer.
   */
  async importSyncCode(code, { force = false } = {}) {
    try {
      const json = decodeURIComponent(escape(atob(code.trim())));
      const data = JSON.parse(json);

      if (!data.version || !data.lastModified) {
        return { success: false, reason: 'Invalid sync code — missing version or timestamp.' };
      }

      if (!force) {
        const local = await this._getAllData();
        if (local.lastModified && local.lastModified >= data.lastModified) {
          return {
            success: false,
            skipped: true,
            reason: 'Local data is the same age or newer.',
            localTime: new Date(local.lastModified).toLocaleString(),
            importTime: new Date(data.lastModified).toLocaleString(),
          };
        }
      }

      await this._applyData(data);
      return { success: true, importTime: new Date(data.lastModified).toLocaleString() };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  // ----------------------------------------------------------------
  // browser.storage.sync — automatic within-browser-family sync
  // ----------------------------------------------------------------

  /**
   * Push current local data to browser.storage.sync (chunked).
   * Called automatically whenever settings, mappings, or identity change
   * and browserSync setting is enabled.
   */
  async pushToSyncStorage() {
    if (!api.storage?.sync) return;
    try {
      const data = await this._getAllData();
      const json = JSON.stringify(data);

      // Split into chunks to stay under per-item quota
      const chunks = [];
      for (let i = 0; i < json.length; i += SYNC_CHUNK_SIZE) {
        chunks.push(json.slice(i, i + SYNC_CHUNK_SIZE));
      }

      // Remove stale chunks
      const staleKeys = await this._getSyncChunkKeys();
      if (staleKeys.length > 0) {
        await api.storage.sync.remove(staleKeys);
      }

      // Write new chunks + metadata in one shot
      const toWrite = {
        [SYNC_META_KEY]: { chunks: chunks.length, lastModified: data.lastModified },
      };
      chunks.forEach((chunk, i) => { toWrite[SYNC_KEY_PREFIX + i] = chunk; });
      await api.storage.sync.set(toWrite);
    } catch (e) {
      console.warn('[Silent Send] pushToSyncStorage failed:', e);
    }
  },

  /**
   * Pull from browser.storage.sync and apply if newer than local.
   * Returns { imported: true, time } if data was applied, null otherwise.
   */
  async pullFromSyncStorage() {
    if (!api.storage?.sync) return null;
    try {
      const metaResult = await api.storage.sync.get(SYNC_META_KEY);
      const syncMeta = metaResult[SYNC_META_KEY];
      if (!syncMeta?.chunks) return null;

      // Skip if local is already up to date
      const local = await this._getAllData();
      if (local.lastModified && local.lastModified >= syncMeta.lastModified) return null;

      // Reassemble chunks
      const chunkKeys = Array.from({ length: syncMeta.chunks }, (_, i) => SYNC_KEY_PREFIX + i);
      const chunkResult = await api.storage.sync.get(chunkKeys);
      const json = chunkKeys.map(k => chunkResult[k] || '').join('');
      const data = JSON.parse(json);

      await this._applyData(data);
      return { imported: true, time: new Date(data.lastModified).toLocaleString() };
    } catch (e) {
      console.warn('[Silent Send] pullFromSyncStorage failed:', e);
      return null;
    }
  },

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  async _getAllData() {
    const result = await api.storage.local.get(null);
    return {
      version: '1',
      lastModified: result.ss_lastModified || Date.now(),
      identity: result.ss_identity || {},
      mappings: result.ss_mappings || [],
      settings: result.ss_settings || {},
    };
  },

  async _applyData(data) {
    const toSet = { ss_lastModified: data.lastModified };
    if (data.identity !== undefined) toSet.ss_identity = data.identity;
    if (data.mappings !== undefined) toSet.ss_mappings = data.mappings;
    if (data.settings !== undefined) toSet.ss_settings = data.settings;
    await api.storage.local.set(toSet);
  },

  async _getSyncChunkKeys() {
    if (!api.storage?.sync) return [];
    try {
      const all = await api.storage.sync.get(null);
      return Object.keys(all).filter(k => k.startsWith(SYNC_KEY_PREFIX));
    } catch {
      return [];
    }
  },

  // ----------------------------------------------------------------
  // File System Access API helpers — folder-based sync
  // The directory handle is stored in IndexedDB so the user only
  // needs to grant access once per browser session.
  // ----------------------------------------------------------------

  _dbPromise: null,

  _openDB() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('ss_sync_handles', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  },

  async saveSyncDirHandle(handle) {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'syncDir');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },

  async loadSyncDirHandle() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('handles', 'readonly');
        const req = tx.objectStore('handles').get('syncDir');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  async clearSyncDirHandle() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').delete('syncDir');
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch { /* ignore */ }
  },
};

export default SilentSendSync;
