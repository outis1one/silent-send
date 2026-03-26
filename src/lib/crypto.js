/**
 * Silent Send - Crypto Module
 *
 * AES-256-GCM encryption with PBKDF2 key derivation.
 * Used for encrypted export/import of user data.
 */

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ITERATIONS = 100000;

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
};

export default SilentSendCrypto;
