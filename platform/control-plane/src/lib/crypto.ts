/**
 * Secret encryption/decryption utilities.
 *
 * Uses AES-256-GCM authenticated encryption.
 * Key comes from SECRET_ENCRYPTION_KEY environment variable.
 *
 * IMPORTANT: This uses Node.js built-in crypto — no external library.
 * AES-256-GCM is a well-audited NIST standard.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96 bits recommended for GCM
const TAG_LENGTH = 16;  // 128-bit authentication tag

/**
 * Encrypts a plaintext string and returns a Buffer containing:
 * [iv (12 bytes)][authTag (16 bytes)][ciphertext (...)]
 */
export function encryptSecret(plaintext: string): Buffer {
  const key = Buffer.from(config.secretEncryptionKey, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypts a Buffer produced by encryptSecret().
 */
export function decryptSecret(encrypted: Buffer): string {
  const key = Buffer.from(config.secretEncryptionKey, 'hex');

  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final('utf8');
}
