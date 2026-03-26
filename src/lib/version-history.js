/**
 * Silent Send - Version History Manager
 *
 * Manages sync version history using IndexedDB. Stores snapshots of the
 * extension's data (identity, mappings, settings) so the user can
 * rollback to a previous state after a sync overwrites local data.
 *
 * Each snapshot records the source that triggered it (e.g. 'gist',
 * 'browser-sync', 'rollback') and a full copy of the data at that
 * point in time. Old snapshots are automatically pruned to stay within
 * a configurable maximum (default 10).
 *
 * Database: IndexedDB 'ss_version_history', version 1
 * Object store: 'snapshots' (autoIncrement keyPath 'id', index on 'timestamp')
 */

const DB_NAME = 'ss_version_history';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const DEFAULT_MAX_SNAPSHOTS = 10;

const VersionHistory = {
  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  /**
   * Open (or create/upgrade) the IndexedDB database.
   * @returns {Promise<IDBDatabase>}
   */
  async _openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Save a snapshot of the current extension data.
   *
   * @param {Object} data - The data payload to snapshot.
   * @param {string} data.version - Data schema version.
   * @param {number} data.lastModified - Epoch ms of the data.
   * @param {Object} data.identity - Identity fields.
   * @param {Array}  data.mappings - Substitution mappings.
   * @param {Object} data.settings - Extension settings.
   * @param {string} source - Origin of the snapshot, e.g.
   *   'local'|'gist'|'url'|'browser-sync'|'file'|'code'|'rollback'.
   * @returns {Promise<number>} The auto-generated snapshot id.
   */
  async saveSnapshot(data, source) {
    const db = await this._openDB();
    const snapshot = {
      timestamp: Date.now(),
      source,
      data,
    };

    const id = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.add(snapshot);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    db.close();

    // Prune old snapshots beyond the configured maximum
    const maxVersions = data?.settings?.maxVersionHistory ?? DEFAULT_MAX_SNAPSHOTS;
    await this.pruneToMax(maxVersions);

    return id;
  },

  /**
   * Retrieve all snapshots, sorted newest first.
   * @returns {Promise<Array>} Array of snapshot objects.
   */
  async getSnapshots() {
    const db = await this._openDB();
    const snapshots = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    db.close();

    // Sort newest first by timestamp (fallback to id descending)
    snapshots.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
    return snapshots;
  },

  /**
   * Retrieve a single snapshot by id.
   * @param {number} id - The snapshot id.
   * @returns {Promise<Object|undefined>} The snapshot, or undefined.
   */
  async getSnapshot(id) {
    const db = await this._openDB();
    const snapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    db.close();
    return snapshot;
  },

  /**
   * Delete a single snapshot by id.
   * @param {number} id - The snapshot id to remove.
   * @returns {Promise<void>}
   */
  async deleteSnapshot(id) {
    const db = await this._openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    db.close();
  },

  /**
   * Keep only the N newest snapshots, deleting the rest.
   * @param {number} [maxVersions] - Maximum snapshots to retain
   *   (defaults to DEFAULT_MAX_SNAPSHOTS).
   * @returns {Promise<void>}
   */
  async pruneToMax(maxVersions) {
    const max = maxVersions ?? DEFAULT_MAX_SNAPSHOTS;
    if (max < 1) return;

    const db = await this._openDB();
    const allSnapshots = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // Sort newest first, then mark everything beyond `max` for deletion
    allSnapshots.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
    const toDelete = allSnapshots.slice(max);

    if (toDelete.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const snap of toDelete) {
          store.delete(snap.id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    db.close();
  },

  /**
   * Delete all snapshots (wipe version history).
   * @returns {Promise<void>}
   */
  async clearAll() {
    const db = await this._openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    db.close();
  },
};

export default VersionHistory;
