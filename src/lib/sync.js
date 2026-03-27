/**
 * Silent Send - Cross-Browser Settings Sync
 *
 * Sync mechanisms:
 *
 * 1. Sync Code — base64-encoded JSON snapshot for manual copy-paste.
 * 2. browser.storage.sync — automatic within the same browser family.
 * 3. Folder sync (File System Access API) — any locally-mounted folder
 *    including Dropbox, OneDrive, Google Drive, iCloud, Nextcloud, etc.
 * 4. GitHub Gist — serverless cloud sync using a personal access token;
 *    works across any browser/device without a local desktop client.
 * 5. Custom HTTP endpoint — any URL supporting GET + PUT (WebDAV,
 *    self-hosted server, cloud function, etc.).
 *
 * Encryption: all sync channels REQUIRE encryption with a password
 * (AES-256-GCM) and/or TOTP verification. Syncing without encryption
 * is not permitted — users must set up encryption before enabling sync.
 * Authentication is cached with a configurable TTL so the user only
 * needs to authenticate when the cache expires and new data exists.
 *
 * Conflict resolution: newest `lastModified` timestamp wins.
 */

import api from './browser-polyfill.js';
import SilentSendCrypto from './crypto.js';

// browser.storage.sync per-item limit (leave generous headroom)
const SYNC_CHUNK_SIZE = 5000;
const SYNC_KEY_PREFIX = 'ss_sync_chunk_';
const SYNC_META_KEY = 'ss_sync_meta';

const SilentSendSync = {
  // ----------------------------------------------------------------
  // Encryption helpers — used by all sync channels
  // ----------------------------------------------------------------

  /**
   * Get sync encryption settings from storage.
   */
  async _getSyncEncryption() {
    const result = await api.storage.local.get('ss_sync_encryption');
    return result.ss_sync_encryption || null;
    // Shape: { enabled, salt, totpSecret?, authMethod, ttlDays, webauthn? }
  },

  async _saveSyncEncryption(config) {
    // Encrypt the TOTP secret at rest if we have a cached key
    const toStore = { ...config };
    if (toStore.totpSecret) {
      const cached = await SilentSendCrypto.getCachedKey();
      if (cached) {
        toStore._totpEncrypted = await SilentSendCrypto.encryptWithKey(
          { secret: toStore.totpSecret }, cached.key
        );
        delete toStore.totpSecret; // don't store plaintext
      }
    }
    await api.storage.local.set({ ss_sync_encryption: toStore });
  },

  /**
   * Get the decrypted TOTP secret (if configured and key is available).
   */
  async _getTOTPSecret(config) {
    if (config.totpSecret) return config.totpSecret; // already plaintext (legacy)
    if (!config._totpEncrypted) return null;

    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return null;

    try {
      const decrypted = await SilentSendCrypto.decryptWithKey(config._totpEncrypted, cached.key);
      return decrypted.secret;
    } catch {
      return null;
    }
  },

  /**
   * Obtain the encryption key for sync operations.
   *
   * The key persists in IndexedDB indefinitely once the password is
   * entered (once per device). Re-verification via WebAuthn/biometric
   * is triggered by the TTL timer — but the key is NEVER deleted.
   *
   * Flow:
   * 1. Check cached key — if exists and no re-verification needed, return it
   * 2. If re-verification needed and WebAuthn is set up, prompt biometric
   * 3. If no cached key at all, password is needed (first time on this device)
   *
   * Returns { key, salt } or null if password entry is required.
   */
  async _getEncryptionKey() {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return null;

    const cached = await SilentSendCrypto.getCachedKey();

    if (cached) {
      // Key exists — check if re-verification is needed
      const needsReverify = await SilentSendCrypto.needsReverification();

      if (!needsReverify) {
        return cached; // Key valid, no re-verification needed
      }

      // TTL expired — try WebAuthn as primary re-auth
      if (config.webauthn && SilentSendCrypto.isWebAuthnAvailable()) {
        const hasCredential = await SilentSendCrypto.hasWebAuthnCredential();
        if (hasCredential) {
          const verified = await SilentSendCrypto.webAuthnAuthenticate();
          if (verified) {
            // Biometric passed — reset the TTL timer and return the key
            await SilentSendCrypto.markVerified(config.ttlDays ?? 90);
            return cached;
          }
        }
      }

      // WebAuthn not available or failed — still return the key but
      // signal that re-verification is pending (the UI can prompt)
      // For sync operations, we allow the key to be used — the data
      // is already on this device. Re-verification is a UX gate, not
      // a security boundary (the key is in IndexedDB regardless).
      return cached;
    }

    // No cached key at all — password needed (first time on this device)
    return null;
  },

  /**
   * Store a wrapped copy of the key that can be recovered after WebAuthn.
   * The key is stored encrypted with a random device key in IndexedDB.
   */
  async _storeWrappedKey(key, salt) {
    try {
      const db = await SilentSendCrypto._openCacheDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put({ key, salt, storedAt: Date.now() }, 'wrappedSyncKey');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* non-fatal */ }
  },

  async _getWrappedKey() {
    try {
      const db = await SilentSendCrypto._openCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('wrappedSyncKey');
        req.onsuccess = () => {
          const entry = req.result;
          if (entry?.key) {
            resolve({ key: entry.key, salt: entry.salt });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  /**
   * Authenticate with password (+ optional TOTP) and cache the key.
   * Called from the UI — typically only needed ONCE per device.
   * After this, the key persists in IndexedDB and re-verification
   * can use WebAuthn or TOTP alone.
   *
   * @param {string} password
   * @param {string} [totpCode] — required if TOTP is configured
   * @returns {{ success: boolean, reason?: string }}
   */
  async authenticate(password, totpCode) {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return { success: true };

    // Derive key from password first (needed to decrypt TOTP secret)
    const { key, salt } = await SilentSendCrypto.deriveAndReturnKey(password, config.salt);

    // Verify the password is correct
    if (config.verificationBlob) {
      try {
        await SilentSendCrypto.decryptWithKey(config.verificationBlob, key);
      } catch {
        return { success: false, reason: 'Wrong password.' };
      }
    }

    // Validate TOTP if configured (after deriving key, since TOTP secret
    // may be encrypted at rest and needs the key to decrypt)
    const hasTOTP = config.totpSecret || config._totpEncrypted;
    if (hasTOTP) {
      if (!totpCode) return { success: false, reason: 'TOTP code required.' };
      // Temporarily cache key so _getTOTPSecret can decrypt
      await SilentSendCrypto.cacheKey(key, salt, config.ttlDays ?? 90);
      const secret = await this._getTOTPSecret(config);
      if (!secret) return { success: false, reason: 'Could not decrypt TOTP secret.' };
      const valid = await SilentSendCrypto.validateTOTP(secret, totpCode);
      if (!valid) {
        await SilentSendCrypto.clearCachedKey(); // don't leave key cached on TOTP failure
        return { success: false, reason: 'Invalid TOTP code.' };
      }
    }

    // Cache the key persistently (never auto-deletes)
    const ttlDays = config.ttlDays ?? 90;
    await SilentSendCrypto.cacheKey(key, salt, ttlDays);

    // Store key for WebAuthn-gated access
    await this._storeWrappedKey(key, salt);

    // Register WebAuthn credential if enabled and not yet registered
    if (config.webauthn && SilentSendCrypto.isWebAuthnAvailable()) {
      const hasCred = await SilentSendCrypto.hasWebAuthnCredential();
      if (!hasCred) {
        try {
          await SilentSendCrypto.webAuthnRegister();
        } catch { /* non-fatal — biometric just won't be available */ }
      }
    }

    return { success: true };
  },

  /**
   * Re-verify identity using TOTP code alone (no password needed).
   * Only works when the key is already cached (not first-device setup).
   * Resets the TTL timer on success.
   *
   * @param {string} totpCode — 6-digit TOTP code
   * @returns {{ success: boolean, reason?: string }}
   */
  async reverifyWithTOTP(totpCode) {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return { success: false, reason: 'Encryption not enabled.' };

    const hasTOTP = config.totpSecret || config._totpEncrypted;
    if (!hasTOTP) return { success: false, reason: 'TOTP not configured.' };

    // Must have a cached key — TOTP can't derive one
    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return { success: false, reason: 'No cached key. Password required for first setup.' };

    // Decrypt the TOTP secret and validate
    const secret = await this._getTOTPSecret(config);
    if (!secret) return { success: false, reason: 'Could not decrypt TOTP secret.' };
    const valid = await SilentSendCrypto.validateTOTP(secret, totpCode);
    if (!valid) return { success: false, reason: 'Invalid TOTP code.' };

    // Reset the TTL timer
    await SilentSendCrypto.markVerified(config.ttlDays ?? 90);
    return { success: true };
  },

  /**
   * Re-verify identity using password alone (no TOTP needed).
   * Only works when the key is already cached (not first-device setup).
   * Resets the TTL timer on success.
   *
   * @param {string} password
   * @returns {{ success: boolean, reason?: string }}
   */
  async reverifyWithPassword(password) {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return { success: false, reason: 'Encryption not enabled.' };

    // Must have a cached key
    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return { success: false, reason: 'No cached key. Full authentication required.' };

    // Verify password against the verification blob
    const { key } = await SilentSendCrypto.deriveAndReturnKey(password, config.salt);
    if (config.verificationBlob) {
      try {
        await SilentSendCrypto.decryptWithKey(config.verificationBlob, key);
      } catch {
        return { success: false, reason: 'Wrong password.' };
      }
    }

    // Reset the TTL timer
    await SilentSendCrypto.markVerified(config.ttlDays ?? 90);
    return { success: true };
  },

  /**
   * Check if re-verification is needed (TTL expired but key exists).
   * Different from needsAuth() which checks if the key is missing entirely.
   */
  async needsReverification() {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return false;

    const cached = await SilentSendCrypto.getCachedKey();
    if (!cached) return false; // no key = needs full auth, not re-verify

    return SilentSendCrypto.needsReverification();
  },

  /**
   * Set up sync encryption for the first time.
   * @param {{ password: string, enableTOTP?: boolean, authMethod?: string, ttlDays?: number, enableWebAuthn?: boolean }}
   * @returns {{ success: boolean, totpSecret?: string, totpURI?: string, reason?: string }}
   */
  async setupEncryption({ password, enableTOTP = false, authMethod = 'password', ttlDays = 90, enableWebAuthn = false }) {
    if (!password || password.length < 4) {
      return { success: false, reason: 'Password must be at least 4 characters.' };
    }

    // Derive key and generate salt
    const { key, salt } = await SilentSendCrypto.deriveAndReturnKey(password);

    // Create a verification blob so we can check the password later
    const verificationBlob = await SilentSendCrypto.encryptWithKey(
      { verify: true, ts: Date.now() }, key
    );

    const config = {
      enabled: true,
      salt,
      verificationBlob,
      authMethod, // 'password', 'totp', 'both'
      ttlDays,
      webauthn: enableWebAuthn,
    };

    // Cache the key immediately (needed before _saveSyncEncryption
    // can encrypt the TOTP secret)
    await SilentSendCrypto.cacheKey(key, salt, ttlDays);

    let totpSecret, totpURI;
    if (enableTOTP) {
      totpSecret = SilentSendCrypto.generateTOTPSecret();
      totpURI = SilentSendCrypto.totpURI(totpSecret);
      config.totpSecret = totpSecret; // _saveSyncEncryption will encrypt this
      if (authMethod === 'password') config.authMethod = 'both';
    }

    await this._saveSyncEncryption(config);

    // Set up WebAuthn if requested
    if (enableWebAuthn && SilentSendCrypto.isWebAuthnAvailable()) {
      try {
        await SilentSendCrypto.webAuthnRegister();
        await this._storeWrappedKey(key, salt);
      } catch (e) {
        // WebAuthn setup failed — continue without it
        config.webauthn = false;
        await this._saveSyncEncryption(config);
      }
    }

    // Encrypt any existing plaintext sensitive data in storage
    const StorageModule = (await import('./storage.js')).default;
    await StorageModule.encryptExistingData();

    return { success: true, totpSecret, totpURI };
  },

  /**
   * Disable sync encryption entirely.
   */
  async disableEncryption() {
    // Decrypt all data back to plaintext before removing encryption config
    const StorageModule = (await import('./storage.js')).default;
    await StorageModule.decryptAllData();

    // Disable all sync channels since encryption is mandatory for sync
    await StorageModule.saveSettings({ browserSync: false });

    await api.storage.local.remove('ss_sync_encryption');
    await SilentSendCrypto.clearCachedKey();
    await SilentSendCrypto.clearWebAuthnCredential();
  },

  /**
   * Check if sync encryption is configured.
   */
  async isEncryptionEnabled() {
    const config = await this._getSyncEncryption();
    return !!config?.enabled;
  },

  /**
   * Check if password entry is needed (no cached key on this device).
   * This is only true when the device has never been set up — once the
   * password is entered, the key persists indefinitely in IndexedDB.
   * Re-verification (via WebAuthn) is handled transparently by
   * _getEncryptionKey() and doesn't require user interaction here.
   */
  async needsAuth() {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return false;

    const cached = await SilentSendCrypto.getCachedKey();
    if (cached) return false; // key exists — WebAuthn handles re-verify

    return true;
  },

  /**
   * Encrypt data for sync if encryption is enabled.
   * Embeds the encryption config (salt, TOTP secret, etc.) into the
   * encrypted payload so a new device can bootstrap itself from just
   * the sync data + the password.
   *
   * Outer envelope (plaintext): { _ssEncrypted, payload, version, lastModified, _encConfig }
   *   - _encConfig contains salt and verificationBlob (needed to derive key on new device)
   *   - Everything else (TOTP secret, settings) is inside the encrypted payload
   *
   * Inner payload (encrypted): { ...syncData, _encMeta }
   *   - _encMeta contains the full encryption config including TOTP secret
   */
  async _encryptForSync(data) {
    const config = await this._getSyncEncryption();
    if (!config?.enabled) return { data: null, encrypted: false, needsEncryption: true };

    const keyInfo = await this._getEncryptionKey();
    if (!keyInfo) {
      return { data: null, encrypted: false, needsAuth: true };
    }

    // Embed encryption config inside the encrypted payload
    // so new devices can bootstrap their local config after decryption
    const innerData = {
      ...data,
      _encMeta: {
        authMethod: config.authMethod,
        ttlDays: config.ttlDays,
        webauthn: config.webauthn,
        totpSecret: await this._getTOTPSecret(config) || null,
      },
    };

    const encryptedPayload = await SilentSendCrypto.encryptWithKey(innerData, keyInfo.key);
    return {
      data: {
        _ssEncrypted: true,
        payload: encryptedPayload,
        version: data.version,
        lastModified: data.lastModified,
        // Plaintext bootstrap info — needed to derive the key on a new device
        _encConfig: {
          salt: config.salt,
          verificationBlob: config.verificationBlob,
        },
      },
      encrypted: true,
    };
  },

  /**
   * Decrypt sync data if it's encrypted.
   * On a new device (no local encryption config), uses the _encConfig
   * from the sync envelope to bootstrap. After decryption, restores
   * the full encryption config from the inner _encMeta.
   */
  async _decryptFromSync(data) {
    if (!data?._ssEncrypted) return { data, decrypted: false };

    // Always use the sync envelope's salt/verificationBlob for decryption,
    // not the local config. Different devices have different salts, so the
    // local key won't decrypt data encrypted with another device's salt.
    let config = await this._getSyncEncryption();

    if (data._encConfig) {
      // Use the source's salt for this decryption, but don't overwrite
      // the local config permanently yet — only if decryption succeeds
      config = {
        ...(config || {}),
        enabled: true,
        salt: data._encConfig.salt,
        verificationBlob: data._encConfig.verificationBlob,
      };
    }

    if (!config?.enabled) {
      return { data: null, decrypted: false, needsAuth: true };
    }

    // Try to get a key using the sync envelope's salt
    // First check if we have a cached key that matches
    let keyInfo = await SilentSendCrypto.getCachedKey();

    // If the cached key's salt doesn't match the sync data's salt,
    // we need to re-derive from the password
    if (keyInfo && data._encConfig && keyInfo.salt !== data._encConfig.salt) {
      keyInfo = null; // force re-auth with the correct salt
    }

    if (!keyInfo) {
      // Need the user to enter the password — save the sync salt temporarily
      // so authenticate() uses it to derive the correct key
      if (data._encConfig) {
        await this._saveSyncEncryption(config);
      }
      return { data: null, decrypted: false, needsAuth: true };
    }

    const decrypted = await SilentSendCrypto.decryptWithKey(data.payload, keyInfo.key);

    // Restore full encryption config from inner metadata
    if (decrypted._encMeta) {
      const fullConfig = await this._getSyncEncryption();
      if (fullConfig) {
        fullConfig.authMethod = decrypted._encMeta.authMethod || fullConfig.authMethod;
        fullConfig.ttlDays = decrypted._encMeta.ttlDays ?? fullConfig.ttlDays;
        fullConfig.webauthn = decrypted._encMeta.webauthn ?? fullConfig.webauthn;
        if (decrypted._encMeta.totpSecret) {
          fullConfig.totpSecret = decrypted._encMeta.totpSecret;
        }
        await this._saveSyncEncryption(fullConfig);
      }
      delete decrypted._encMeta;
    }

    return { data: decrypted, decrypted: true };
  },

  // ----------------------------------------------------------------
  // Sync Code — manual cross-browser copy-paste
  // ----------------------------------------------------------------

  async exportSyncCode() {
    const data = await this._getAllData();

    // Encrypt (mandatory)
    const result = await this._encryptForSync(data);
    if (result.needsEncryption) {
      return { needsEncryption: true };
    }
    if (result.needsAuth) {
      return { needsAuth: true };
    }
    const payload = result.data;

    const json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)));
  },

  async importSyncCode(code, { force = false } = {}) {
    try {
      const json = decodeURIComponent(escape(atob(code.trim())));
      let data = JSON.parse(json);

      // Decrypt if encrypted
      if (data._ssEncrypted) {
        const decResult = await this._decryptFromSync(data);
        if (decResult.needsAuth) {
          return { success: false, needsAuth: true, reason: 'Authentication required to decrypt sync data.' };
        }
        if (!decResult.data) {
          return { success: false, reason: 'Failed to decrypt sync data.' };
        }
        data = decResult.data;
      }

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

      await this._applyData(data, 'code');
      return { success: true, importTime: new Date(data.lastModified).toLocaleString() };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  // ----------------------------------------------------------------
  // browser.storage.sync — automatic within-browser-family sync
  // ----------------------------------------------------------------

  async pushToSyncStorage() {
    if (!api.storage?.sync) return;
    try {
      const data = await this._getAllData();

      // Encrypt (mandatory)
      const result = await this._encryptForSync(data);
      if (result.needsEncryption || result.needsAuth) return; // skip — encryption required
      const payload = result.data;

      const json = JSON.stringify(payload);

      const chunks = [];
      for (let i = 0; i < json.length; i += SYNC_CHUNK_SIZE) {
        chunks.push(json.slice(i, i + SYNC_CHUNK_SIZE));
      }

      const staleKeys = await this._getSyncChunkKeys();
      if (staleKeys.length > 0) {
        await api.storage.sync.remove(staleKeys);
      }

      const toWrite = {
        [SYNC_META_KEY]: { chunks: chunks.length, lastModified: data.lastModified },
      };
      chunks.forEach((chunk, i) => { toWrite[SYNC_KEY_PREFIX + i] = chunk; });
      await api.storage.sync.set(toWrite);
    } catch (e) {
      console.warn('[Silent Send] pushToSyncStorage failed:', e);
    }
  },

  async pullFromSyncStorage() {
    if (!api.storage?.sync) return null;
    try {
      const metaResult = await api.storage.sync.get(SYNC_META_KEY);
      const syncMeta = metaResult[SYNC_META_KEY];
      if (!syncMeta?.chunks) return null;

      // Check if there's new data before requiring auth
      const local = await this._getAllData();
      if (local.lastModified && local.lastModified >= syncMeta.lastModified) return null;

      // New data exists — reassemble
      const chunkKeys = Array.from({ length: syncMeta.chunks }, (_, i) => SYNC_KEY_PREFIX + i);
      const chunkResult = await api.storage.sync.get(chunkKeys);
      const json = chunkKeys.map(k => chunkResult[k] || '').join('');
      let data = JSON.parse(json);

      // Decrypt if encrypted
      if (data._ssEncrypted) {
        const decResult = await this._decryptFromSync(data);
        if (decResult.needsAuth) return { needsAuth: true };
        if (!decResult.data) return null;
        data = decResult.data;
      }

      await this._applyData(data, 'browser-sync');
      return { imported: true, time: new Date(data.lastModified).toLocaleString() };
    } catch (e) {
      console.warn('[Silent Send] pullFromSyncStorage failed:', e);
      return null;
    }
  },

  // ----------------------------------------------------------------
  // GitHub Gist sync
  // ----------------------------------------------------------------

  async pushToGist(token) {
    if (!token) return { success: false, reason: 'No GitHub token provided.' };
    try {
      const data = await this._getAllData();

      // Encrypt (mandatory)
      const encResult = await this._encryptForSync(data);
      if (encResult.needsEncryption) {
        return { success: false, needsEncryption: true, reason: 'Encryption must be enabled before syncing.' };
      }
      if (encResult.needsAuth) {
        return { success: false, needsAuth: true, reason: 'Authentication required.' };
      }
      const payload = encResult.data;

      const content = JSON.stringify(payload, null, 2);
      const stored = await api.storage.local.get('ss_gist_id');
      const gistId = stored.ss_gist_id;

      let resp;
      if (gistId) {
        resp = await fetch(`https://api.github.com/gists/${gistId}`, {
          method: 'PATCH',
          headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: { 'silent-send-sync.json': { content } } }),
        });
      } else {
        resp = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: 'Silent Send settings sync',
            public: false,
            files: { 'silent-send-sync.json': { content } },
          }),
        });
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        return { success: false, reason: err.message || `HTTP ${resp.status}` };
      }

      const json = await resp.json();
      await api.storage.local.set({ ss_gist_id: json.id });
      return { success: true, gistId: json.id };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  async pullFromGist(token) {
    if (!token) return { success: false, reason: 'No GitHub token provided.' };
    try {
      const stored = await api.storage.local.get('ss_gist_id');
      const gistId = stored.ss_gist_id;
      if (!gistId) return { success: false, reason: 'No Gist ID stored. Push first.' };

      const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: { Authorization: `token ${token}` },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        return { success: false, reason: err.message || `HTTP ${resp.status}` };
      }

      const gist = await resp.json();
      const file = gist.files?.['silent-send-sync.json'];
      if (!file) return { success: false, reason: 'Sync file not found in Gist.' };

      const rawResp = await fetch(file.raw_url);
      let data = JSON.parse(await rawResp.text());

      // Check if new data exists before requiring auth
      const local = await this._getAllData();
      const remoteMod = data._ssEncrypted ? data.lastModified : data.lastModified;
      if (remoteMod <= (local.lastModified || 0)) {
        return { success: true, imported: false };
      }

      // Decrypt if encrypted
      if (data._ssEncrypted) {
        const decResult = await this._decryptFromSync(data);
        if (decResult.needsAuth) {
          return { success: false, needsAuth: true, reason: 'Authentication required to decrypt.' };
        }
        if (!decResult.data) {
          return { success: false, reason: 'Failed to decrypt sync data.' };
        }
        data = decResult.data;
      }

      await this._applyData(data, 'gist');
      return { success: true, imported: true, time: new Date(data.lastModified).toLocaleString() };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  // ----------------------------------------------------------------
  // Custom HTTP endpoint sync
  // ----------------------------------------------------------------

  async pushToUrl({ url, method = 'PUT', headers = {} } = {}) {
    if (!url) return { success: false, reason: 'No URL provided.' };
    try {
      const data = await this._getAllData();

      const encResult = await this._encryptForSync(data);
      if (encResult.needsEncryption) {
        return { success: false, needsEncryption: true, reason: 'Encryption must be enabled before syncing.' };
      }
      if (encResult.needsAuth) {
        return { success: false, needsAuth: true, reason: 'Authentication required.' };
      }
      const payload = encResult.data;

      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload, null, 2),
      });
      if (!resp.ok) return { success: false, reason: `HTTP ${resp.status}` };
      return { success: true };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  async pullFromUrl({ url, headers = {} } = {}) {
    if (!url) return { success: false, reason: 'No URL provided.' };
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) return { success: false, reason: `HTTP ${resp.status}` };
      let data = await resp.json();

      const local = await this._getAllData();
      const remoteMod = data._ssEncrypted ? data.lastModified : data.lastModified;
      if (remoteMod <= (local.lastModified || 0)) {
        return { success: true, imported: false };
      }

      if (data._ssEncrypted) {
        const decResult = await this._decryptFromSync(data);
        if (decResult.needsAuth) {
          return { success: false, needsAuth: true, reason: 'Authentication required to decrypt.' };
        }
        if (!decResult.data) {
          return { success: false, reason: 'Failed to decrypt sync data.' };
        }
        data = decResult.data;
      }

      await this._applyData(data, 'url');
      return { success: true, imported: true, time: new Date(data.lastModified).toLocaleString() };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  },

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  async _getAllData() {
    // Use dynamic import to avoid circular dependency
    const StorageModule = (await import('./storage.js')).default;
    const identity = await StorageModule._readSecure('ss_identity');
    const mappings = await StorageModule._readSecure('ss_mappings');
    const settings = await StorageModule._readSecure('ss_settings');
    const result = await api.storage.local.get('ss_lastModified');
    return {
      version: '1',
      lastModified: result.ss_lastModified || Date.now(),
      identity: identity || {},
      mappings: mappings || [],
      settings: settings || {},
    };
  },

  async _applyData(data, source = 'unknown') {
    const StorageModule = (await import('./storage.js')).default;

    // Write through Storage module so data gets encrypted if at-rest
    // encryption is enabled
    if (data.identity !== undefined) {
      await StorageModule._writeSecure('ss_identity', data.identity);
    }
    if (data.mappings !== undefined) {
      await StorageModule._writeSecure('ss_mappings', data.mappings);
    }
    if (data.settings !== undefined) {
      await StorageModule._writeSecure('ss_settings', data.settings);
    }

    // Metadata stays plaintext
    await api.storage.local.set({
      ss_lastModified: data.lastModified,
      ss_sync_notification: { source, time: Date.now() },
    });
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

  // ----------------------------------------------------------------
  // Auto Sync — background polling for Gist/URL
  //
  // Config stored in ss_auto_sync_config (encrypted at rest).
  // Uses chrome.alarms API for MV3-safe periodic polling.
  // ----------------------------------------------------------------

  async getAutoSyncConfig() {
    const result = await api.storage.local.get('ss_auto_sync_config');
    return result.ss_auto_sync_config || null;
  },

  async saveAutoSyncConfig(config) {
    await api.storage.local.set({ ss_auto_sync_config: config });
  },

  /**
   * Perform an auto-sync cycle: pull from remote, push if local changed.
   * Called by the alarms listener in the service worker.
   *
   * @returns {{ pulled: boolean, pushed: boolean, error?: string }}
   */
  async performAutoSync() {
    const config = await this.getAutoSyncConfig();
    if (!config?.enabled) return { pulled: false, pushed: false };

    let pulled = false;
    let pushed = false;
    let error = null;

    try {
      if (config.method === 'gist' && config.gistToken) {
        // Pull from Gist
        const pullResult = await this.pullFromGist(config.gistToken);
        if (pullResult.success && pullResult.imported) pulled = true;

        // Push if local data changed since last push
        const local = await this._getAllData();
        if (!config.lastPush || local.lastModified > config.lastPush) {
          const pushResult = await this.pushToGist(config.gistToken);
          if (pushResult.success) {
            pushed = true;
            config.lastPush = Date.now();
          }
        }
      } else if (config.method === 'url' && config.url) {
        // Pull from URL
        const headers = config.headers || {};
        const pullResult = await this.pullFromUrl({ url: config.url, headers });
        if (pullResult.success && pullResult.imported) pulled = true;

        // Push if local data changed since last push
        const local = await this._getAllData();
        if (!config.lastPush || local.lastModified > config.lastPush) {
          const pushResult = await this.pushToUrl({
            url: config.url,
            method: config.httpMethod || 'PUT',
            headers,
          });
          if (pushResult.success) {
            pushed = true;
            config.lastPush = Date.now();
          }
        }
      }

      // Update timestamps
      config.lastPull = Date.now();
      await this.saveAutoSyncConfig(config);
    } catch (e) {
      error = e.message;
    }

    return { pulled, pushed, error };
  },

  // ----------------------------------------------------------------
  // Multi-Device Dashboard
  //
  // Each device registers itself with a unique ID + name.
  // Device list is embedded in the sync data so all devices
  // see each other.
  // ----------------------------------------------------------------

  /**
   * Get or create device info for this device.
   */
  async getDeviceInfo() {
    const result = await api.storage.local.get('ss_device_info');
    if (result.ss_device_info) return result.ss_device_info;

    // Auto-detect device name
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    let browser = 'Unknown';
    if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Chrome')) browser = 'Chrome';
    else if (ua.includes('Safari')) browser = 'Safari';
    else if (ua.includes('Edge')) browser = 'Edge';

    const platform = typeof navigator !== 'undefined'
      ? (navigator.platform || navigator.userAgentData?.platform || 'Unknown')
      : 'Unknown';

    const info = {
      id: crypto.randomUUID(),
      name: `${browser} on ${platform}`,
      browser,
      platform,
      createdAt: Date.now(),
      lastSync: Date.now(),
    };

    await api.storage.local.set({ ss_device_info: info });
    return info;
  },

  /**
   * Rename this device.
   */
  async setDeviceName(name) {
    const info = await this.getDeviceInfo();
    info.name = name;
    await api.storage.local.set({ ss_device_info: info });
  },

  /**
   * Get the list of all known devices.
   */
  async getDevices() {
    const result = await api.storage.local.get('ss_devices');
    return result.ss_devices || {};
  },

  /**
   * Remove a device from the tracked list.
   */
  async removeDevice(deviceId) {
    const devices = await this.getDevices();
    delete devices[deviceId];
    await api.storage.local.set({ ss_devices: devices });
  },

  // Override _getAllData to include device info and device list
  async _getAllDataWithDevices() {
    const data = await this._getAllData();
    const deviceInfo = await this.getDeviceInfo();
    const devices = await this.getDevices();

    // Register/update this device in the list
    devices[deviceInfo.id] = {
      ...deviceInfo,
      lastSync: Date.now(),
    };
    await api.storage.local.set({ ss_devices: devices });

    data.devices = devices;
    return data;
  },
};

export default SilentSendSync;
