/**
 * Silent Send - Storage Manager
 *
 * Wraps browser/api.storage.local with typed helpers for mappings,
 * activity log, and settings.
 */

import api from './browser-polyfill.js';

const KEYS = {
  MAPPINGS: 'ss_mappings',
  IDENTITY: 'ss_identity',
  LOG: 'ss_activity_log',
  SETTINGS: 'ss_settings',
};

const DEFAULT_SETTINGS = {
  enabled: true,
  showHighlights: false,
  revealMode: false,
  secretScanning: true,
  autoDetect: true,
  maxLogEntries: 200,
  customDomains: [],
  categories: ['name', 'email', 'phone', 'address', 'ssn', 'dob', 'domain', 'general'],
};

const Storage = {
  // --- Mappings ---

  async getMappings() {
    const result = await api.storage.local.get(KEYS.MAPPINGS);
    return result[KEYS.MAPPINGS] || [];
  },

  async saveMappings(mappings) {
    await api.storage.local.set({ [KEYS.MAPPINGS]: mappings });
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
    const result = await api.storage.local.get(KEYS.IDENTITY);
    const data = result[KEYS.IDENTITY];
    if (data?.profiles) return data.profiles;
    return [];
  },

  async saveProfiles(profiles) {
    await api.storage.local.set({ [KEYS.IDENTITY]: { profiles } });
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
    const result = await api.storage.local.get(KEYS.LOG);
    return result[KEYS.LOG] || [];
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

    await api.storage.local.set({ [KEYS.LOG]: log });
  },

  async clearLog() {
    await api.storage.local.set({ [KEYS.LOG]: [] });
  },

  // --- Settings ---

  async getSettings() {
    const result = await api.storage.local.get(KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(result[KEYS.SETTINGS] || {}) };
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    await api.storage.local.set({
      [KEYS.SETTINGS]: { ...current, ...settings },
    });
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.SilentSendStorage = Storage;
}

export default Storage;
