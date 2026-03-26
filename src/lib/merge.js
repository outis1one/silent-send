/**
 * Silent Send - Three-Way Field-Level Merge
 *
 * Handles conflict resolution when syncing data between devices.
 * Instead of "newest wins", compares an ancestor (last synced state)
 * against both local and remote changes, auto-merges non-conflicting
 * fields, and surfaces true conflicts for the user to resolve.
 *
 * Data structures merged:
 * - identity: { profiles: [{ id, name, active, emails, names, ... }] }
 * - mappings: [{ id, real, substitute, category, ... }]
 * - settings: { enabled, showHighlights, customDomains, ... }
 */

/**
 * Deep-equal comparison for two values (objects, arrays, primitives).
 * Good enough for JSON-serializable sync data.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => deepEqual(a[k], b[k]));
  }

  return false;
}

/**
 * Deep clone a JSON-serializable value.
 * @param {*} v
 * @returns {*}
 */
function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}

const SilentSendMerge = {
  /**
   * Three-way merge of all sync data.
   *
   * @param {{ identity: object, mappings: Array, settings: object }} ancestor - last synced state
   * @param {{ identity: object, mappings: Array, settings: object }} local - current local state
   * @param {{ identity: object, mappings: Array, settings: object }} remote - incoming remote state
   * @returns {{ merged: { identity: object, mappings: Array, settings: object }, conflicts: Array<{ id: string, path: string, localValue: *, remoteValue: *, ancestorValue: * }> }}
   */
  mergeData(ancestor, local, remote) {
    const mappingsResult = this._mergeMappings(
      ancestor?.mappings || [],
      local?.mappings || [],
      remote?.mappings || [],
    );

    const settingsResult = this._mergeSettings(
      ancestor?.settings || {},
      local?.settings || {},
      remote?.settings || {},
    );

    const identityResult = this._mergeIdentity(
      ancestor?.identity || {},
      local?.identity || {},
      remote?.identity || {},
    );

    return {
      merged: {
        identity: identityResult.merged,
        mappings: mappingsResult.merged,
        settings: settingsResult.merged,
      },
      conflicts: [
        ...mappingsResult.conflicts,
        ...settingsResult.conflicts,
        ...identityResult.conflicts,
      ],
    };
  },

  /**
   * Merge mappings arrays by `id` field.
   *
   * Rules:
   * - New on one side only -> auto-add
   * - Deleted on one side, unchanged on other -> auto-delete
   * - Deleted on one side, changed on other -> conflict
   * - Changed on both sides -> conflict (unless changes are identical)
   * - Changed on one side only -> accept the change
   *
   * @param {Array} ancestor
   * @param {Array} local
   * @param {Array} remote
   * @returns {{ merged: Array, conflicts: Array }}
   */
  _mergeMappings(ancestor, local, remote) {
    const ancestorMap = new Map(ancestor.map((m) => [m.id, m]));
    const localMap = new Map(local.map((m) => [m.id, m]));
    const remoteMap = new Map(remote.map((m) => [m.id, m]));

    const allIds = new Set([
      ...ancestorMap.keys(),
      ...localMap.keys(),
      ...remoteMap.keys(),
    ]);

    const merged = [];
    const conflicts = [];

    for (const id of allIds) {
      const a = ancestorMap.get(id);
      const l = localMap.get(id);
      const r = remoteMap.get(id);

      const inA = ancestorMap.has(id);
      const inL = localMap.has(id);
      const inR = remoteMap.has(id);

      // New on local only (not in ancestor or remote)
      if (!inA && inL && !inR) {
        merged.push(clone(l));
        continue;
      }

      // New on remote only
      if (!inA && !inL && inR) {
        merged.push(clone(r));
        continue;
      }

      // New on both sides (same id independently — unlikely with UUIDs but handle it)
      if (!inA && inL && inR) {
        if (deepEqual(l, r)) {
          merged.push(clone(l));
        } else {
          // Both added with same id but different content — conflict
          merged.push(clone(l));
          conflicts.push({
            id,
            path: `mappings[${id}]`,
            localValue: clone(l),
            remoteValue: clone(r),
            ancestorValue: null,
          });
        }
        continue;
      }

      // Existed in ancestor
      if (inA) {
        const localChanged = !deepEqual(a, l);
        const remoteChanged = !deepEqual(a, r);
        const localDeleted = !inL;
        const remoteDeleted = !inR;

        // Deleted on both sides
        if (localDeleted && remoteDeleted) {
          continue; // gone
        }

        // Deleted locally, unchanged remotely -> delete
        if (localDeleted && !remoteChanged) {
          continue;
        }

        // Deleted remotely, unchanged locally -> delete
        if (remoteDeleted && !localChanged) {
          continue;
        }

        // Deleted on one side but changed on other -> conflict
        if (localDeleted && remoteChanged) {
          conflicts.push({
            id,
            path: `mappings[${id}]`,
            localValue: null,
            remoteValue: clone(r),
            ancestorValue: clone(a),
          });
          // Keep the remote version in merged for now (user must resolve)
          merged.push(clone(r));
          continue;
        }
        if (remoteDeleted && localChanged) {
          conflicts.push({
            id,
            path: `mappings[${id}]`,
            localValue: clone(l),
            remoteValue: null,
            ancestorValue: clone(a),
          });
          merged.push(clone(l));
          continue;
        }

        // Both present
        if (!localChanged && !remoteChanged) {
          merged.push(clone(a)); // unchanged
        } else if (localChanged && !remoteChanged) {
          merged.push(clone(l));
        } else if (!localChanged && remoteChanged) {
          merged.push(clone(r));
        } else {
          // Both changed
          if (deepEqual(l, r)) {
            merged.push(clone(l)); // same change on both sides
          } else {
            merged.push(clone(l)); // default to local, flag conflict
            conflicts.push({
              id,
              path: `mappings[${id}]`,
              localValue: clone(l),
              remoteValue: clone(r),
              ancestorValue: clone(a),
            });
          }
        }
      }
    }

    return { merged, conflicts };
  },

  /**
   * Merge settings objects by key.
   *
   * `customDomains` is treated specially: union of both sides (deduplicated).
   * All other keys use standard three-way field comparison.
   *
   * @param {object} ancestor
   * @param {object} local
   * @param {object} remote
   * @returns {{ merged: object, conflicts: Array }}
   */
  _mergeSettings(ancestor, local, remote) {
    const merged = {};
    const conflicts = [];

    const allKeys = new Set([
      ...Object.keys(ancestor),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);

    for (const key of allKeys) {
      const a = ancestor[key];
      const l = local[key];
      const r = remote[key];

      // Special handling for customDomains — union both sides
      if (key === 'customDomains') {
        const localDomains = Array.isArray(l) ? l : [];
        const remoteDomains = Array.isArray(r) ? r : [];
        merged[key] = [...new Set([...localDomains, ...remoteDomains])];
        continue;
      }

      // Special handling for categories — union both sides
      if (key === 'categories') {
        const localCats = Array.isArray(l) ? l : [];
        const remoteCats = Array.isArray(r) ? r : [];
        merged[key] = [...new Set([...localCats, ...remoteCats])];
        continue;
      }

      const localChanged = !deepEqual(a, l);
      const remoteChanged = !deepEqual(a, r);

      if (!localChanged && !remoteChanged) {
        merged[key] = clone(a); // unchanged
      } else if (localChanged && !remoteChanged) {
        merged[key] = clone(l);
      } else if (!localChanged && remoteChanged) {
        merged[key] = clone(r);
      } else {
        // Both changed
        if (deepEqual(l, r)) {
          merged[key] = clone(l); // same change
        } else {
          merged[key] = clone(l); // default to local, flag conflict
          conflicts.push({
            id: key,
            path: `settings.${key}`,
            localValue: clone(l),
            remoteValue: clone(r),
            ancestorValue: clone(a),
          });
        }
      }
    }

    return { merged, conflicts };
  },

  /**
   * Merge identity objects.
   *
   * Profiles are matched by `id`. Within each profile, top-level scalar
   * fields (name, active, catchAllEmail, etc.) use three-way comparison.
   * Array fields (emails, names, usernames, hostnames, phones, emailDomains)
   * are compared by index position for simplicity.
   *
   * @param {object} ancestor
   * @param {object} local
   * @param {object} remote
   * @returns {{ merged: object, conflicts: Array }}
   */
  _mergeIdentity(ancestor, local, remote) {
    const ancestorProfiles = ancestor?.profiles || [];
    const localProfiles = local?.profiles || [];
    const remoteProfiles = remote?.profiles || [];

    const ancestorMap = new Map(ancestorProfiles.map((p) => [p.id, p]));
    const localMap = new Map(localProfiles.map((p) => [p.id, p]));
    const remoteMap = new Map(remoteProfiles.map((p) => [p.id, p]));

    const allIds = new Set([
      ...ancestorMap.keys(),
      ...localMap.keys(),
      ...remoteMap.keys(),
    ]);

    const mergedProfiles = [];
    const conflicts = [];

    for (const id of allIds) {
      const a = ancestorMap.get(id);
      const l = localMap.get(id);
      const r = remoteMap.get(id);

      const inA = ancestorMap.has(id);
      const inL = localMap.has(id);
      const inR = remoteMap.has(id);

      // New on one side only
      if (!inA && inL && !inR) {
        mergedProfiles.push(clone(l));
        continue;
      }
      if (!inA && !inL && inR) {
        mergedProfiles.push(clone(r));
        continue;
      }
      if (!inA && inL && inR) {
        if (deepEqual(l, r)) {
          mergedProfiles.push(clone(l));
        } else {
          mergedProfiles.push(clone(l));
          conflicts.push({
            id,
            path: `identity.profiles[${id}]`,
            localValue: clone(l),
            remoteValue: clone(r),
            ancestorValue: null,
          });
        }
        continue;
      }

      if (!inA) continue;

      const localDeleted = !inL;
      const remoteDeleted = !inR;

      // Both deleted
      if (localDeleted && remoteDeleted) continue;

      // Deleted on one side, check if other side changed
      if (localDeleted) {
        if (deepEqual(a, r)) {
          continue; // deleted locally, unchanged remotely -> delete
        }
        conflicts.push({
          id,
          path: `identity.profiles[${id}]`,
          localValue: null,
          remoteValue: clone(r),
          ancestorValue: clone(a),
        });
        mergedProfiles.push(clone(r));
        continue;
      }
      if (remoteDeleted) {
        if (deepEqual(a, l)) {
          continue; // deleted remotely, unchanged locally -> delete
        }
        conflicts.push({
          id,
          path: `identity.profiles[${id}]`,
          localValue: clone(l),
          remoteValue: null,
          ancestorValue: clone(a),
        });
        mergedProfiles.push(clone(l));
        continue;
      }

      // Both present — merge field by field within the profile
      const mergedProfile = this._mergeProfile(id, a, l, r, conflicts);
      mergedProfiles.push(mergedProfile);
    }

    return {
      merged: { profiles: mergedProfiles },
      conflicts,
    };
  },

  /**
   * Merge a single identity profile field by field.
   *
   * Scalar fields: standard three-way comparison.
   * Array fields (emails, names, etc.): compared by index position.
   * The `enabled` sub-object: merged key by key.
   *
   * @param {string} profileId
   * @param {object} ancestor
   * @param {object} local
   * @param {object} remote
   * @param {Array} conflicts - mutated; conflicts are pushed here
   * @returns {object} merged profile
   */
  _mergeProfile(profileId, ancestor, local, remote, conflicts) {
    const merged = { id: profileId };
    const arrayFields = new Set(['emails', 'names', 'usernames', 'hostnames', 'phones', 'emailDomains']);
    const allKeys = new Set([
      ...Object.keys(ancestor),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);

    for (const key of allKeys) {
      if (key === 'id') continue;

      const a = ancestor[key];
      const l = local[key];
      const r = remote[key];

      // Merge `enabled` sub-object key by key
      if (key === 'enabled' && typeof l === 'object' && typeof r === 'object') {
        merged[key] = this._mergeEnabledFlags(profileId, a || {}, l, r, conflicts);
        continue;
      }

      // Array fields — compare by index
      if (arrayFields.has(key)) {
        merged[key] = this._mergeArray(profileId, key, a || [], l || [], r || [], conflicts);
        continue;
      }

      // Scalar fields
      const localChanged = !deepEqual(a, l);
      const remoteChanged = !deepEqual(a, r);

      if (!localChanged && !remoteChanged) {
        merged[key] = clone(a);
      } else if (localChanged && !remoteChanged) {
        merged[key] = clone(l);
      } else if (!localChanged && remoteChanged) {
        merged[key] = clone(r);
      } else {
        if (deepEqual(l, r)) {
          merged[key] = clone(l);
        } else {
          merged[key] = clone(l);
          conflicts.push({
            id: `${profileId}.${key}`,
            path: `identity.profiles[${profileId}].${key}`,
            localValue: clone(l),
            remoteValue: clone(r),
            ancestorValue: clone(a),
          });
        }
      }
    }

    return merged;
  },

  /**
   * Merge the `enabled` flags sub-object within a profile.
   *
   * @param {string} profileId
   * @param {object} ancestor
   * @param {object} local
   * @param {object} remote
   * @param {Array} conflicts
   * @returns {object}
   */
  _mergeEnabledFlags(profileId, ancestor, local, remote, conflicts) {
    const merged = {};
    const allKeys = new Set([
      ...Object.keys(ancestor),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);

    for (const key of allKeys) {
      const a = ancestor[key];
      const l = local[key];
      const r = remote[key];

      const localChanged = a !== l;
      const remoteChanged = a !== r;

      if (!localChanged && !remoteChanged) {
        merged[key] = a;
      } else if (localChanged && !remoteChanged) {
        merged[key] = l;
      } else if (!localChanged && remoteChanged) {
        merged[key] = r;
      } else {
        if (l === r) {
          merged[key] = l;
        } else {
          merged[key] = l;
          conflicts.push({
            id: `${profileId}.enabled.${key}`,
            path: `identity.profiles[${profileId}].enabled.${key}`,
            localValue: l,
            remoteValue: r,
            ancestorValue: a,
          });
        }
      }
    }

    return merged;
  },

  /**
   * Merge an array field within a profile by index position.
   *
   * Entries that exist at the same index in ancestor, local, and remote
   * are compared field by field. New entries appended on either side are
   * added. Entries removed from one side but unchanged on other are removed.
   *
   * For simplicity, if the array lengths diverge in complex ways, we fall
   * back to whole-array comparison and flag a conflict if both changed.
   *
   * @param {string} profileId
   * @param {string} fieldName
   * @param {Array} ancestor
   * @param {Array} local
   * @param {Array} remote
   * @param {Array} conflicts
   * @returns {Array}
   */
  _mergeArray(profileId, fieldName, ancestor, local, remote, conflicts) {
    const maxLen = Math.max(ancestor.length, local.length, remote.length);

    // Simple case: neither side changed
    if (deepEqual(ancestor, local) && deepEqual(ancestor, remote)) {
      return clone(ancestor);
    }

    // Only one side changed
    if (deepEqual(ancestor, local) && !deepEqual(ancestor, remote)) {
      return clone(remote);
    }
    if (!deepEqual(ancestor, local) && deepEqual(ancestor, remote)) {
      return clone(local);
    }

    // Both changed — try index-level merge
    const merged = [];
    let hasConflict = false;

    for (let i = 0; i < maxLen; i++) {
      const a = i < ancestor.length ? ancestor[i] : undefined;
      const l = i < local.length ? local[i] : undefined;
      const r = i < remote.length ? remote[i] : undefined;

      const localChanged = !deepEqual(a, l);
      const remoteChanged = !deepEqual(a, r);

      if (!localChanged && !remoteChanged) {
        if (a !== undefined) merged.push(clone(a));
      } else if (localChanged && !remoteChanged) {
        if (l !== undefined) merged.push(clone(l));
        // l undefined means local deleted this index — skip
      } else if (!localChanged && remoteChanged) {
        if (r !== undefined) merged.push(clone(r));
      } else {
        // Both changed at this index
        if (deepEqual(l, r)) {
          if (l !== undefined) merged.push(clone(l));
        } else {
          if (l !== undefined) merged.push(clone(l));
          hasConflict = true;
        }
      }
    }

    if (hasConflict) {
      conflicts.push({
        id: `${profileId}.${fieldName}`,
        path: `identity.profiles[${profileId}].${fieldName}`,
        localValue: clone(local),
        remoteValue: clone(remote),
        ancestorValue: clone(ancestor),
      });
    }

    return merged;
  },

  /**
   * Apply a user's conflict resolution choice to the merged data.
   *
   * Navigates the `path` in the merged object and replaces the value
   * with either the local or remote version from the conflict record.
   *
   * @param {{ identity: object, mappings: Array, settings: object }} merged
   * @param {{ id: string, path: string, localValue: *, remoteValue: * }} conflict
   * @param {'local'|'remote'} choice
   * @returns {{ identity: object, mappings: Array, settings: object }} the mutated merged object
   */
  resolveConflict(merged, conflict, choice) {
    const value = choice === 'remote' ? conflict.remoteValue : conflict.localValue;
    const path = conflict.path;

    // Handle mapping conflicts: mappings[<id>]
    const mappingMatch = path.match(/^mappings\[(.+)]$/);
    if (mappingMatch) {
      const id = mappingMatch[1];
      if (value === null) {
        // Choice is to delete
        merged.mappings = merged.mappings.filter((m) => m.id !== id);
      } else {
        const idx = merged.mappings.findIndex((m) => m.id === id);
        if (idx !== -1) {
          merged.mappings[idx] = clone(value);
        } else {
          merged.mappings.push(clone(value));
        }
      }
      return merged;
    }

    // Handle settings conflicts: settings.<key>
    const settingsMatch = path.match(/^settings\.(.+)$/);
    if (settingsMatch) {
      const key = settingsMatch[1];
      merged.settings[key] = clone(value);
      return merged;
    }

    // Handle identity profile-level conflicts: identity.profiles[<id>]
    const profileMatch = path.match(/^identity\.profiles\[(.+)]$/);
    if (profileMatch) {
      const id = profileMatch[1];
      if (value === null) {
        merged.identity.profiles = merged.identity.profiles.filter((p) => p.id !== id);
      } else {
        const idx = merged.identity.profiles.findIndex((p) => p.id === id);
        if (idx !== -1) {
          merged.identity.profiles[idx] = clone(value);
        } else {
          merged.identity.profiles.push(clone(value));
        }
      }
      return merged;
    }

    // Handle profile field conflicts: identity.profiles[<id>].<field>
    const fieldMatch = path.match(/^identity\.profiles\[(.+?)]\.(.+)$/);
    if (fieldMatch) {
      const id = fieldMatch[1];
      const fieldPath = fieldMatch[2];
      const profile = merged.identity.profiles.find((p) => p.id === id);
      if (profile) {
        // Handle nested paths like "enabled.emails"
        const parts = fieldPath.split('.');
        let target = profile;
        for (let i = 0; i < parts.length - 1; i++) {
          target = target[parts[i]];
          if (!target) break;
        }
        if (target) {
          target[parts[parts.length - 1]] = clone(value);
        }
      }
      return merged;
    }

    return merged;
  },
};

export default SilentSendMerge;
