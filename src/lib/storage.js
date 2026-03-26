/**
 * Silent Send - Storage Manager
 *
 * Wraps browser/api.storage.local with typed helpers for mappings,
 * activity log, and settings.
 *
 * When at-rest encryption is enabled, sensitive data (identity, mappings,
 * activity log) is AES-encrypted before writing to storage.local and
 * decrypted on read. The encryption key comes from the key cache in
 * IndexedDB (derived from the user's password on first setup).
 *
 * Non-sensitive data (settings, sync metadata) remains plaintext so the
 * extension can function in a "locked" state (showing the unlock prompt).
 */

import api from './browser-polyfill.js';
import SilentSendCrypto from './crypto.js';

const KEYS = {
  MAPPINGS: 'ss_mappings',
  IDENTITY: 'ss_identity',
  LOG: 'ss_activity_log',
  SETTINGS: 'ss_settings',
};

// Keys that contain sensitive PPI and should be encrypted at rest
// All user data keys are encrypted at rest — settings included since
// custom domains and configuration can reveal what services the user
// accesses. Only ss_sync_encryption (salt, verification blob) and
// ss_lastModified stay plaintext for bootstrap purposes.
const ENCRYPTED_KEYS = new Set([KEYS.MAPPINGS, KEYS.IDENTITY, KEYS.LOG, KEYS.SETTINGS]);

const DEFAULT_SETTINGS = {
  enabled: true,
  showHighlights: false,
  revealMode: false,
  secretScanning: true,
  autoDetect: true,
  autoRedactDetected: true,
  autoAddDetected: true,
  maxLogEntries: 200,
  customDomains: [],
  categories: ['name', 'email', 'phone', 'address', 'ssn', 'dob', 'domain', 'password', 'general'],
  browserSync: false,
};

const Storage = {
  // ----------------------------------------------------------------
  // At-rest encryption helpers
  // ----------------------------------------------------------------

  /**
   * Check if at-rest encryption is enabled.
   * At-rest encryption piggybacks on sync encryption — if the user
   * has set up sync encryption, local storage is also encrypted.
   */
  async _isAtRestEncryptionEnabled() {
    const result = await api.storage.local.get('ss_sync_encryption');
    return !!result.ss_sync_encryption?.enabled;
  },

  /**
   * Read a potentially-encrypted value from storage.
   * Returns the decrypted value, or null if locked.
   */
  async _readSecure(key) {
    const result = await api.storage.local.get(key);
    const value = result[key];

    // Not encrypted — return as-is
    if (!value || !value._ssLocalEncrypted) return value || null;

    // Encrypted — need the cached key
    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return null; // locked

    try {
      return await SilentSendCrypto.decryptWithKey(value.data, cached.key);
    } catch {
      return null; // corrupted or wrong key
    }
  },

  /**
   * Write a value to storage, encrypting if at-rest encryption is enabled.
   */
  async _writeSecure(key, value, extras = {}) {
    const isEncEnabled = await this._isAtRestEncryptionEnabled();

    if (isEncEnabled && ENCRYPTED_KEYS.has(key)) {
      const cached = await SilentSendCrypto.getCachedKey();
      if (cached) {
        const encrypted = await SilentSendCrypto.encryptWithKey(value, cached.key);
        await api.storage.local.set({
          [key]: { _ssLocalEncrypted: true, data: encrypted },
          ...extras,
        });
        return;
      }
      // No key available — fall through to plaintext (shouldn't happen
      // if the UI flow is correct, but better than losing data)
    }

    await api.storage.local.set({ [key]: value, ...extras });
  },

  /**
   * Check if the extension is in a locked state (encrypted data, no key).
   */
  async isLocked() {
    const isEncEnabled = await this._isAtRestEncryptionEnabled();
    if (!isEncEnabled) return false;

    const cached = await SilentSendCrypto.getCachedKey();
    if (cached) return false;

    return true;
  },

  /**
   * Encrypt all existing plaintext sensitive data after encryption is
   * first enabled. Called once when the user sets up sync encryption.
   */
  async encryptExistingData() {
    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return;

    for (const key of ENCRYPTED_KEYS) {
      const result = await api.storage.local.get(key);
      const value = result[key];
      // Skip if already encrypted or empty
      if (!value || value._ssLocalEncrypted) continue;

      const encrypted = await SilentSendCrypto.encryptWithKey(value, cached.key);
      await api.storage.local.set({
        [key]: { _ssLocalEncrypted: true, data: encrypted },
      });
    }
  },

  /**
   * Decrypt all encrypted data back to plaintext. Called when the user
   * disables sync encryption.
   */
  async decryptAllData() {
    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return;

    for (const key of ENCRYPTED_KEYS) {
      const result = await api.storage.local.get(key);
      const value = result[key];
      if (!value?._ssLocalEncrypted) continue;

      try {
        const decrypted = await SilentSendCrypto.decryptWithKey(value.data, cached.key);
        await api.storage.local.set({ [key]: decrypted });
      } catch { /* leave encrypted if decryption fails */ }
    }
  },

  // --- Mappings ---

  async getMappings() {
    const data = await this._readSecure(KEYS.MAPPINGS);
    return data || [];
  },

  async saveMappings(mappings) {
    await this._writeSecure(KEYS.MAPPINGS, mappings, { ss_lastModified: Date.now() });
  },

  async addMapping(mapping) {
    const mappings = await this.getMappings();
    const newMapping = {
      id: crypto.randomUUID(),
      real: mapping.real || '',
      substitute: mapping.substitute || '',
      category: mapping.category || 'general',
      caseSensitive: mapping.caseSensitive ?? false,
      enabled: mapping.enabled ?? true,
      createdAt: Date.now(),
    };
    mappings.push(newMapping);
    await this.saveMappings(mappings);
    return newMapping;
  },

  async updateMapping(id, updates) {
    const mappings = await this.getMappings();
    const idx = mappings.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    mappings[idx] = { ...mappings[idx], ...updates };
    await this.saveMappings(mappings);
    return mappings[idx];
  },

  async deleteMapping(id) {
    const mappings = await this.getMappings();
    const filtered = mappings.filter((m) => m.id !== id);
    await this.saveMappings(filtered);
  },

  // --- Identity Profiles (Smart Patterns) ---

  _emptyProfile() {
    return {
      id: crypto.randomUUID(),
      name: 'Personal',
      active: true,
      emails: [],
      names: [],
      usernames: [],
      hostnames: [],
      phones: [],
      catchAllEmail: '',
      emailDomains: [],
      enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
    };
  },

  async getProfiles() {
    const data = await this._readSecure(KEYS.IDENTITY);
    if (data?.profiles) return data.profiles;
    return [];
  },

  async saveProfiles(profiles) {
    await this._writeSecure(KEYS.IDENTITY, { profiles }, { ss_lastModified: Date.now() });
  },

  async addProfile(name) {
    const profiles = await this.getProfiles();
    const profile = { ...this._emptyProfile(), name: name || `Profile ${profiles.length + 1}` };
    profiles.push(profile);
    await this.saveProfiles(profiles);
    return profile;
  },

  async updateProfile(id, updates) {
    const profiles = await this.getProfiles();
    const idx = profiles.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    profiles[idx] = { ...profiles[idx], ...updates };
    await this.saveProfiles(profiles);
    return profiles[idx];
  },

  async deleteProfile(id) {
    const profiles = await this.getProfiles();
    const filtered = profiles.filter((p) => p.id !== id);
    await this.saveProfiles(filtered);
  },

  // Merged identity: combines all active profiles into one identity object
  // for the substitution engine (which expects a single identity)
  async getIdentity() {
    const profiles = await this.getProfiles();
    const active = profiles.filter((p) => p.active);

    if (active.length === 0) {
      return { emails: [], names: [], usernames: [], hostnames: [], phones: [],
        catchAllEmail: '', emailDomains: [], enabled: { emails: true, names: true, usernames: true, phones: true, paths: true } };
    }

    // Merge all active profiles
    const merged = {
      emails: [],
      names: [],
      usernames: [],
      hostnames: [],
      phones: [],
      catchAllEmail: '',
      emailDomains: [],
      enabled: { emails: true, names: true, usernames: true, phones: true, paths: true },
    };

    for (const p of active) {
      merged.emails.push(...(p.emails || []));
      merged.names.push(...(p.names || []));
      merged.usernames.push(...(p.usernames || []));
      merged.hostnames.push(...(p.hostnames || []));
      merged.phones.push(...(p.phones || []));
      if (p.catchAllEmail && !merged.catchAllEmail) merged.catchAllEmail = p.catchAllEmail;
      merged.emailDomains.push(...(p.emailDomains || []));
    }

    return merged;
  },

  // Legacy compat: saveIdentity saves to first profile
  async saveIdentity(identity) {
    const profiles = await this.getProfiles();
    if (profiles.length === 0) {
      const profile = { ...this._emptyProfile(), ...identity };
      await this.saveProfiles([profile]);
    } else {
      profiles[0] = { ...profiles[0], ...identity };
      await this.saveProfiles(profiles);
    }
  },

  // --- Activity Log ---

  async getLog() {
    const data = await this._readSecure(KEYS.LOG);
    return data || [];
  },

  async addLogEntry(entry) {
    const settings = await this.getSettings();
    const log = await this.getLog();

    log.unshift({
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    });

    // Trim to max entries
    if (log.length > settings.maxLogEntries) {
      log.length = settings.maxLogEntries;
    }

    await this._writeSecure(KEYS.LOG, log);
  },

  async clearLog() {
    await this._writeSecure(KEYS.LOG, []);
  },

  // --- Settings ---
  // Settings are encrypted at rest (custom domains can reveal which
  // private AI services the user accesses). When locked, defaults are
  // returned so the extension can show basic UI.

  async getSettings() {
    const data = await this._readSecure(KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(data || {}) };
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    await this._writeSecure(
      KEYS.SETTINGS,
      { ...current, ...settings },
      { ss_lastModified: Date.now() },
    );
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.SilentSendStorage = Storage;
}

export default Storage;
