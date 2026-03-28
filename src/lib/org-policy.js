/**
 * Silent Send - Organization Policy Manager
 *
 * Enables team/org administrators to enforce substitution policies
 * across all team members. Org-required mappings merge with personal
 * mappings and cannot be disabled by the user.
 *
 * Policy distribution:
 * - Admin hosts a JSON policy file at a URL (static host, S3, etc.)
 * - Team members join by entering the policy URL or an invite code
 * - Extension polls the policy URL periodically (default: hourly)
 * - Policy updates are applied automatically
 *
 * Privacy: the org admin can check compliance (are required fields
 * configured?) but CANNOT see individual PPI values.
 */

import api from './browser-polyfill.js';

const ORG_CONFIG_KEY = 'ss_org_config';
const ORG_POLICY_KEY = 'ss_org_policy';

const OrgPolicy = {
  // ----------------------------------------------------------------
  // Join / Leave
  // ----------------------------------------------------------------

  /**
   * Join an organization by policy URL or invite code.
   * Fetches the policy, validates it, and stores locally.
   *
   * @param {{ policyUrl?: string, inviteCode?: string }}
   * @returns {{ success: boolean, orgName?: string, reason?: string }}
   */
  async joinOrg({ policyUrl, inviteCode }) {
    if (!policyUrl && !inviteCode) {
      return { success: false, reason: 'Provide a policy URL or invite code.' };
    }

    // If invite code provided, it encodes the policy URL
    // Format: base64(JSON({ url: '...', orgId: '...' }))
    if (inviteCode && !policyUrl) {
      try {
        const decoded = JSON.parse(atob(inviteCode.trim()));
        policyUrl = decoded.url;
      } catch {
        return { success: false, reason: 'Invalid invite code.' };
      }
    }

    // Fetch and validate the policy
    try {
      const resp = await fetch(policyUrl);
      if (!resp.ok) {
        return { success: false, reason: `Failed to fetch policy: HTTP ${resp.status}` };
      }

      const policy = await resp.json();

      if (!policy.orgId || !policy.orgName) {
        return { success: false, reason: 'Invalid policy — missing orgId or orgName.' };
      }

      // Validate invite code if the policy requires one
      if (policy.inviteCode && inviteCode) {
        try {
          const decoded = JSON.parse(atob(inviteCode.trim()));
          if (decoded.orgId !== policy.orgId) {
            return { success: false, reason: 'Invite code does not match this organization.' };
          }
        } catch { /* non-fatal — URL join doesn't need code */ }
      }

      // Store org config
      await api.storage.local.set({
        [ORG_CONFIG_KEY]: {
          policyUrl,
          orgId: policy.orgId,
          orgName: policy.orgName,
          joinedAt: Date.now(),
          lastFetch: Date.now(),
        },
        [ORG_POLICY_KEY]: policy,
      });

      return { success: true, orgName: policy.orgName };
    } catch (e) {
      return { success: false, reason: 'Failed to fetch policy: ' + e.message };
    }
  },

  /**
   * Leave the organization. Removes org config and policy.
   * May require admin password if tamper protection is enabled.
   */
  async leaveOrg() {
    await api.storage.local.remove([ORG_CONFIG_KEY, ORG_POLICY_KEY]);
  },

  /**
   * Check if user is in an organization.
   */
  async isInOrg() {
    const result = await api.storage.local.get(ORG_CONFIG_KEY);
    return !!result[ORG_CONFIG_KEY]?.orgId;
  },

  /**
   * Get the current org config (non-sensitive metadata).
   */
  async getOrgConfig() {
    const result = await api.storage.local.get(ORG_CONFIG_KEY);
    return result[ORG_CONFIG_KEY] || null;
  },

  // ----------------------------------------------------------------
  // Policy fetch and update
  // ----------------------------------------------------------------

  /**
   * Fetch the latest policy from the org's URL.
   * Only applies if the version is newer than what we have.
   *
   * @returns {{ updated: boolean, reason?: string }}
   */
  async fetchPolicy() {
    const config = await this.getOrgConfig();
    if (!config?.policyUrl) return { updated: false, reason: 'No org configured.' };

    try {
      const resp = await fetch(config.policyUrl);
      if (!resp.ok) return { updated: false, reason: `HTTP ${resp.status}` };

      const policy = await resp.json();
      const current = await this.getPolicy();

      // Only update if version is newer
      if (current && policy.version <= (current.version || 0)) {
        // Update lastFetch timestamp
        config.lastFetch = Date.now();
        await api.storage.local.set({ [ORG_CONFIG_KEY]: config });
        return { updated: false };
      }

      // Store updated policy
      await api.storage.local.set({
        [ORG_POLICY_KEY]: policy,
        [ORG_CONFIG_KEY]: { ...config, lastFetch: Date.now() },
      });

      return { updated: true, version: policy.version };
    } catch (e) {
      return { updated: false, reason: e.message };
    }
  },

  /**
   * Get the cached policy.
   */
  async getPolicy() {
    const result = await api.storage.local.get(ORG_POLICY_KEY);
    return result[ORG_POLICY_KEY] || null;
  },

  // ----------------------------------------------------------------
  // Policy enforcement — merge org rules with personal data
  // ----------------------------------------------------------------

  /**
   * Merge org-required mappings with personal mappings.
   * Org mappings are always included and cannot be disabled.
   *
   * @param {Array} personalMappings - user's own mappings
   * @returns {Array} merged mappings (org + personal)
   */
  async getMergedMappings(personalMappings) {
    const policy = await this.getPolicy();
    if (!policy?.requiredMappings?.length) return personalMappings;

    const orgMappings = policy.requiredMappings.map(m => ({
      id: `org-${policy.orgId}-${m.real}`,
      real: m.real,
      substitute: m.substitute,
      category: m.category || 'org',
      caseSensitive: m.caseSensitive ?? false,
      enabled: true, // always enabled — cannot be disabled
      _orgRequired: true,
      _orgId: policy.orgId,
    }));

    // Remove personal mappings that conflict with org mappings (same real value)
    const orgReals = new Set(orgMappings.map(m => m.real.toLowerCase()));
    const filtered = personalMappings.filter(
      m => !orgReals.has(m.real.toLowerCase())
    );

    return [...orgMappings, ...filtered];
  },

  /**
   * Get org-required auto-redact patterns.
   *
   * @returns {Array} additional patterns to add to auto-redact
   */
  async getOrgSecretPatterns() {
    const policy = await this.getPolicy();
    if (!policy?.requiredSecretPatterns?.length) return [];

    return policy.requiredSecretPatterns.map(p => ({
      name: p.name,
      re: new RegExp(p.regex, 'g'),
      to: p.redact || '[REDACTED]',
      _orgRequired: true,
    }));
  },

  // ----------------------------------------------------------------
  // Compliance checking (anonymized)
  // ----------------------------------------------------------------

  /**
   * Check if the user's configuration meets org policy requirements.
   * Returns compliance status WITHOUT revealing actual PPI values.
   *
   * @returns {{ compliant: boolean, missing: string[], configured: string[] }}
   */
  async checkCompliance() {
    const policy = await this.getPolicy();
    if (!policy) return { compliant: true, missing: [], configured: [] };

    const result = await api.storage.local.get('ss_identity');
    const identity = result.ss_identity || {};
    const profiles = identity.profiles || [];
    const active = profiles.filter(p => p.active);

    const missing = [];
    const configured = [];

    const rules = policy.sharedIdentityRules || {};

    // Check required categories
    if (rules.requiredCategories) {
      for (const cat of rules.requiredCategories) {
        let found = false;
        for (const p of active) {
          switch (cat) {
            case 'name':
              if ((p.names || []).some(n => n.real && n.substitute)) found = true;
              break;
            case 'email':
              if ((p.emails || []).some(e => e.real && e.substitute) || p.catchAllEmail) found = true;
              break;
            case 'username':
              if ((p.usernames || []).some(u => u.real && u.substitute)) found = true;
              break;
            case 'hostname':
              if ((p.hostnames || []).some(h => h.real && h.substitute)) found = true;
              break;
            case 'phone':
              if ((p.phones || []).some(ph => ph.real && ph.substitute)) found = true;
              break;
            case 'domain':
              found = true; // org-required mappings handle this
              break;
          }
        }
        if (found) {
          configured.push(cat);
        } else {
          missing.push(cat);
        }
      }
    }

    // Check catch-all email requirement
    if (rules.requireCatchAllEmail) {
      const hasCatchAll = active.some(p => !!p.catchAllEmail);
      if (hasCatchAll) {
        configured.push('catch-all email');
      } else {
        missing.push('catch-all email');
      }
    }

    return {
      compliant: missing.length === 0,
      missing,
      configured,
    };
  },

  // ----------------------------------------------------------------
  // Invite code generation (for admins)
  // ----------------------------------------------------------------

  /**
   * Generate an invite code from a policy URL and org ID.
   * This is a simple base64 encoding — not a secret.
   */
  generateInviteCode(policyUrl, orgId) {
    return btoa(JSON.stringify({ url: policyUrl, orgId }));
  },
};

export default OrgPolicy;
