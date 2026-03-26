/**
 * Silent Send - Tamper Protection
 *
 * Prevents unauthorized disabling, data clearing, or org policy
 * removal by requiring a separate admin password. This is distinct
 * from the vault encryption password.
 *
 * Protected actions:
 * - Disabling the extension (toggle off)
 * - Clearing all data (reset)
 * - Clearing mappings
 * - Changing or removing org policy URL
 * - Exporting data (plain, unencrypted)
 *
 * Limitations (documented in UI):
 * - Cannot prevent browser-level extension uninstall
 * - Cannot prevent clearing browser data via browser settings
 * - A determined user with dev tools can bypass this
 * - This is a deterrent for casual tampering, not a security boundary
 *
 * Org integration:
 * - If org policy sets disableTamperProtection: false, the tamper
 *   guard cannot be turned off even with the admin password
 * - If org policy sets disableTamperProtection: true, the org
 *   admin is opting out of this feature
 */

import api from './browser-polyfill.js';

const ADMIN_AUTH_KEY = 'ss_admin_auth';
const ITERATIONS = 200000; // higher than sync encryption for extra security
const SALT_LENGTH = 16;

const TamperGuard = {
  /**
   * Check if tamper protection is enabled.
   */
  async isEnabled() {
    const result = await api.storage.local.get(ADMIN_AUTH_KEY);
    return !!result[ADMIN_AUTH_KEY]?.enabled;
  },

  /**
   * Get the tamper guard config (without the password hash).
   */
  async getConfig() {
    const result = await api.storage.local.get(ADMIN_AUTH_KEY);
    const config = result[ADMIN_AUTH_KEY];
    if (!config) return null;
    // Don't expose the hash
    return {
      enabled: config.enabled,
      protectedActions: config.protectedActions,
      orgCanDisable: config.orgCanDisable,
      createdAt: config.createdAt,
    };
  },

  /**
   * Set up tamper protection with an admin password.
   *
   * @param {string} adminPassword - must be different from encryption password
   * @returns {{ success: boolean, reason?: string }}
   */
  async setup(adminPassword) {
    if (!adminPassword || adminPassword.length < 4) {
      return { success: false, reason: 'Admin password must be at least 4 characters.' };
    }

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const hash = await this._hashPassword(adminPassword, salt);

    const config = {
      enabled: true,
      passwordHash: hash,
      salt: btoa(String.fromCharCode(...salt)),
      protectedActions: [
        'disable',
        'clearData',
        'clearMappings',
        'changeOrgPolicy',
        'exportPlain',
      ],
      orgCanDisable: false,
      createdAt: Date.now(),
    };

    await api.storage.local.set({ [ADMIN_AUTH_KEY]: config });
    return { success: true };
  },

  /**
   * Verify the admin password.
   *
   * @param {string} adminPassword
   * @returns {boolean}
   */
  async verify(adminPassword) {
    const result = await api.storage.local.get(ADMIN_AUTH_KEY);
    const config = result[ADMIN_AUTH_KEY];
    if (!config?.enabled) return true; // not enabled = always passes

    const salt = Uint8Array.from(atob(config.salt), c => c.charCodeAt(0));
    const hash = await this._hashPassword(adminPassword, salt);

    return hash === config.passwordHash;
  },

  /**
   * Check if a specific action requires admin authentication.
   *
   * @param {string} action - e.g. 'disable', 'clearData'
   * @returns {boolean}
   */
  async isActionProtected(action) {
    const result = await api.storage.local.get(ADMIN_AUTH_KEY);
    const config = result[ADMIN_AUTH_KEY];
    if (!config?.enabled) return false;
    return (config.protectedActions || []).includes(action);
  },

  /**
   * Require admin authentication for an action.
   * Returns true if auth passes (or isn't needed), false if denied.
   *
   * @param {string} action
   * @param {string} adminPassword
   * @returns {{ allowed: boolean, reason?: string }}
   */
  async requireAuth(action, adminPassword) {
    const isProtected = await this.isActionProtected(action);
    if (!isProtected) return { allowed: true };

    if (!adminPassword) {
      return { allowed: false, reason: 'Admin password required.' };
    }

    const valid = await this.verify(adminPassword);
    if (!valid) {
      return { allowed: false, reason: 'Wrong admin password.' };
    }

    return { allowed: true };
  },

  /**
   * Disable tamper protection.
   * Requires the admin password unless org policy allows disabling.
   *
   * @param {string} adminPassword
   * @returns {{ success: boolean, reason?: string }}
   */
  async disable(adminPassword) {
    // Check org policy
    const orgPolicy = await this._getOrgPolicy();
    if (orgPolicy && orgPolicy.disableTamperProtection === false) {
      return {
        success: false,
        reason: 'Organization policy prevents disabling tamper protection.',
      };
    }

    // Verify password
    const valid = await this.verify(adminPassword);
    if (!valid) {
      return { success: false, reason: 'Wrong admin password.' };
    }

    await api.storage.local.remove(ADMIN_AUTH_KEY);
    return { success: true };
  },

  /**
   * Change the admin password.
   *
   * @param {string} oldPassword
   * @param {string} newPassword
   * @returns {{ success: boolean, reason?: string }}
   */
  async changePassword(oldPassword, newPassword) {
    const valid = await this.verify(oldPassword);
    if (!valid) {
      return { success: false, reason: 'Wrong current admin password.' };
    }

    if (!newPassword || newPassword.length < 4) {
      return { success: false, reason: 'New password must be at least 4 characters.' };
    }

    const result = await api.storage.local.get(ADMIN_AUTH_KEY);
    const config = result[ADMIN_AUTH_KEY];

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    config.passwordHash = await this._hashPassword(newPassword, salt);
    config.salt = btoa(String.fromCharCode(...salt));

    await api.storage.local.set({ [ADMIN_AUTH_KEY]: config });
    return { success: true };
  },

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  /**
   * Hash a password with PBKDF2-SHA256.
   * Returns base64-encoded hash string.
   */
  async _hashPassword(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  },

  /**
   * Get org policy (if any) to check tamper protection override.
   */
  async _getOrgPolicy() {
    try {
      const result = await api.storage.local.get('ss_org_policy');
      return result.ss_org_policy || null;
    } catch {
      return null;
    }
  },
};

export default TamperGuard;
