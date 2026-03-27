/**
 * Silent Send - Crypto Module
 *
 * AES-256-GCM encryption with PBKDF2 key derivation.
 * TOTP (RFC 6238) for optional second factor.
 * Key caching in IndexedDB with configurable TTL.
 * WebAuthn biometric unlock as low-friction re-auth.
 */

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ITERATIONS = 100000;

// TOTP defaults (RFC 6238)
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_WINDOW = 1; // accept ±1 period for clock skew

async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const SilentSendCrypto = {
  /**
   * Encrypt data with a password.
   * Returns a base64 string containing salt + iv + ciphertext.
   */
  async encrypt(data, password) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(password, salt);

    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    // Combine: salt (16) + iv (12) + ciphertext
    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

    // Base64 encode
    return btoa(String.fromCharCode(...combined));
  },

  /**
   * Decrypt data with a password.
   * Takes the base64 string from encrypt().
   */
  async decrypt(encryptedBase64, password) {
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    const salt = combined.slice(0, SALT_LENGTH);
    const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

    const key = await deriveKey(password, salt);

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(plaintext));
    } catch (e) {
      throw new Error('Wrong password or corrupted data');
    }
  },

  /**
   * Encrypt data with a CryptoKey directly (used with cached keys).
   */
  async encryptWithKey(data, key) {
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  },

  /**
   * Decrypt data with a CryptoKey directly (used with cached keys).
   */
  async decryptWithKey(encryptedBase64, key) {
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(plaintext));
    } catch (e) {
      throw new Error('Wrong key or corrupted data');
    }
  },

  // ----------------------------------------------------------------
  // Derive + cache: password → CryptoKey, stored with a salt
  // Returns { key, salt } where salt should be persisted alongside
  // encrypted data so the same password reproduces the same key.
  // ----------------------------------------------------------------

  async deriveAndReturnKey(password, existingSalt) {
    const salt = existingSalt
      ? (typeof existingSalt === 'string'
        ? Uint8Array.from(atob(existingSalt), c => c.charCodeAt(0))
        : existingSalt)
      : crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

    const key = await deriveKey(password, salt);
    const saltB64 = typeof existingSalt === 'string'
      ? existingSalt
      : btoa(String.fromCharCode(...salt));
    return { key, salt: saltB64 };
  },

  // ----------------------------------------------------------------
  // TOTP — Time-based One-Time Password (RFC 6238)
  // ----------------------------------------------------------------

  /**
   * Generate a random TOTP secret (base32-encoded, 20 bytes).
   */
  generateTOTPSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return base32Encode(bytes);
  },

  /**
   * Generate the current TOTP code from a base32 secret.
   */
  async generateTOTP(secret) {
    const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
    return this._hotpCode(secret, counter);
  },

  /**
   * Validate a TOTP code against the secret.
   * Accepts codes within ±TOTP_WINDOW periods for clock skew.
   */
  async validateTOTP(secret, code) {
    const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
    for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
      const expected = await this._hotpCode(secret, counter + i);
      if (expected === code.toString().padStart(TOTP_DIGITS, '0')) {
        return true;
      }
    }
    return false;
  },

  /**
   * Build an otpauth:// URI for QR code generators.
   */
  totpURI(secret, accountName = 'SilentSend', issuer = 'SilentSend') {
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
  },

  async _hotpCode(secret, counter) {
    const keyBytes = base32Decode(secret);
    const counterBuf = new ArrayBuffer(8);
    const view = new DataView(counterBuf);
    view.setBigUint64(0, BigInt(counter));

    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));

    // Dynamic truncation (RFC 4226 §5.4)
    const offset = sig[sig.length - 1] & 0x0f;
    const code = (
      ((sig[offset] & 0x7f) << 24) |
      ((sig[offset + 1] & 0xff) << 16) |
      ((sig[offset + 2] & 0xff) << 8) |
      (sig[offset + 3] & 0xff)
    ) % (10 ** TOTP_DIGITS);

    return code.toString().padStart(TOTP_DIGITS, '0');
  },

  // ----------------------------------------------------------------
  // Key Cache — persist CryptoKey in IndexedDB with TTL
  //
  // The CryptoKey is non-exportable (extractable: false from PBKDF2),
  // so it can only be used via SubtleCrypto, never read as raw bytes.
  // ----------------------------------------------------------------

  _cacheDB: null,

  async _openCacheDB() {
    if (this._cacheDB) return this._cacheDB;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ss_key_cache', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('keys');
      };
      req.onsuccess = () => { this._cacheDB = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Cache a CryptoKey persistently.
   * The key stays in IndexedDB indefinitely — it's only cleared if
   * the user explicitly disables encryption or clears browser data.
   * The TTL controls when re-verification (via WebAuthn) is required,
   * NOT when the key is deleted.
   *
   * @param {CryptoKey} key
   * @param {string} salt - base64-encoded salt used to derive this key
   * @param {number} ttlDays - re-verify interval: 0 = each session, -1 = never
   */
  async cacheKey(key, salt, ttlDays = 90) {
    const db = await this._openCacheDB();
    const reverifyAt = ttlDays === -1
      ? -1 // never re-verify
      : ttlDays === 0
        ? 0 // re-verify each session
        : Date.now() + ttlDays * 86400000;

    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put({ key, salt, reverifyAt, cachedAt: Date.now() }, 'syncKey');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Retrieve cached key. The key is always returned if it exists —
   * it never expires or self-deletes. Use needsReverification() to
   * check if the user should re-verify via WebAuthn.
   *
   * Returns { key: CryptoKey, salt: string } or null.
   */
  async getCachedKey() {
    try {
      const db = await this._openCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('syncKey');
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry?.key) return resolve(null);
          resolve({ key: entry.key, salt: entry.salt });
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  /**
   * Check if the cached key needs re-verification (TTL expired).
   * This does NOT delete the key — it just signals that the user
   * should re-verify via WebAuthn/biometric before using it.
   */
  async needsReverification() {
    try {
      const db = await this._openCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('syncKey');
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry) return resolve(false); // no key = nothing to re-verify
          if (entry.reverifyAt === -1) return resolve(false); // never
          if (entry.reverifyAt === 0) return resolve(true); // each session
          resolve(Date.now() >= entry.reverifyAt);
        };
        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  /**
   * Mark the cached key as freshly verified (resets the TTL timer).
   */
  async markVerified(ttlDays = 90) {
    try {
      const db = await this._openCacheDB();
      const entry = await new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('syncKey');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (!entry) return;

      entry.reverifyAt = ttlDays === -1
        ? -1
        : ttlDays === 0
          ? 0
          : Date.now() + ttlDays * 86400000;

      await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(entry, 'syncKey');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* non-fatal */ }
  },

  async clearCachedKey() {
    try {
      const db = await this._openCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').delete('syncKey');
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch { /* ignore */ }
  },

  // ----------------------------------------------------------------
  // WebAuthn — biometric/PIN as PRIMARY re-authentication
  //
  // On first setup (per device), the user enters their password once
  // to derive the encryption key. A WebAuthn credential is registered
  // on that device. From then on, ALL re-verification uses biometrics
  // — the password is never needed again on that device unless
  // IndexedDB is cleared. The CryptoKey persists indefinitely in
  // IndexedDB; WebAuthn just gates access when TTL expires.
  // ----------------------------------------------------------------

  /**
   * Check if WebAuthn is available in this browser.
   */
  isWebAuthnAvailable() {
    // WebAuthn doesn't work on extension pages (chrome-extension:// origin)
    if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') return false;
    if (typeof location !== 'undefined' && location.protocol === 'moz-extension:') return false;
    return !!(window.PublicKeyCredential && navigator.credentials);
  },

  /**
   * Register a WebAuthn credential for this extension.
   * Returns the credential ID (base64) to store in settings.
   */
  async webAuthnRegister() {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Silent Send' },
        user: {
          id: userId,
          name: 'silentsend-user',
          displayName: 'Silent Send User',
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform', // built-in biometric/PIN
          userVerification: 'required',
          residentKey: 'discouraged',
        },
        timeout: 60000,
      },
    });

    const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));

    // Store credential info in IndexedDB
    const db = await this._openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put({ credId, createdAt: Date.now() }, 'webauthnCred');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    return credId;
  },

  /**
   * Authenticate with WebAuthn (biometric/PIN prompt).
   * Returns true if verification succeeds.
   */
  async webAuthnAuthenticate() {
    try {
      const db = await this._openCacheDB();
      const stored = await new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('webauthnCred');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if (!stored?.credId) return false;

      const credIdBytes = Uint8Array.from(atob(stored.credId), c => c.charCodeAt(0));
      const challenge = crypto.getRandomValues(new Uint8Array(32));

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ type: 'public-key', id: credIdBytes }],
          userVerification: 'required',
          timeout: 60000,
        },
      });

      // If we get here without throwing, the platform verified the user
      return !!assertion;
    } catch {
      return false;
    }
  },

  /**
   * Check if WebAuthn credential is registered.
   */
  async hasWebAuthnCredential() {
    try {
      const db = await this._openCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('webauthnCred');
        req.onsuccess = () => resolve(!!req.result?.credId);
        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  async clearWebAuthnCredential() {
    try {
      const db = await this._openCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').delete('webauthnCred');
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch { /* ignore */ }
  },
};

// ----------------------------------------------------------------
// Base32 encode/decode helpers (RFC 4648, no padding)
// ----------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}

function base32Decode(str) {
  let bits = '';
  for (const c of str.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    bits += B32.indexOf(c).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

export default SilentSendCrypto;
