/**
 * Silent Send - Storage Manager
 *
 * Wraps chrome.storage.local with typed helpers for mappings,
 * activity log, and settings.
 */

const KEYS = {
  MAPPINGS: 'ss_mappings',
  LOG: 'ss_activity_log',
  SETTINGS: 'ss_settings',
};

const DEFAULT_SETTINGS = {
  enabled: true,
  showHighlights: false,
  revealMode: false,
  maxLogEntries: 200,
  categories: ['name', 'email', 'phone', 'address', 'ssn', 'dob', 'general'],
};

const Storage = {
  // --- Mappings ---

  async getMappings() {
    const result = await chrome.storage.local.get(KEYS.MAPPINGS);
    return result[KEYS.MAPPINGS] || [];
  },

  async saveMappings(mappings) {
    await chrome.storage.local.set({ [KEYS.MAPPINGS]: mappings });
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

  // --- Activity Log ---

  async getLog() {
    const result = await chrome.storage.local.get(KEYS.LOG);
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

    await chrome.storage.local.set({ [KEYS.LOG]: log });
  },

  async clearLog() {
    await chrome.storage.local.set({ [KEYS.LOG]: [] });
  },

  // --- Settings ---

  async getSettings() {
    const result = await chrome.storage.local.get(KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(result[KEYS.SETTINGS] || {}) };
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    await chrome.storage.local.set({
      [KEYS.SETTINGS]: { ...current, ...settings },
    });
  },
};

if (typeof globalThis !== 'undefined') {
  globalThis.SilentSendStorage = Storage;
}

export default Storage;
