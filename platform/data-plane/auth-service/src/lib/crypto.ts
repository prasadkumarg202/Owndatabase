/** AES-256-GCM helpers for secrets stored by the auth service (e.g. TOTP seeds). */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const key = config.SECRET_ENCRYPTION_KEY ? Buffer.from(config.SECRET_ENCRYPTION_KEY, 'hex') : null;

export function seal(plain: string): string {
  if (!key) return `plain:${plain}`;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `gcm:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function unseal(stored: string): string {
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (!stored.startsWith('gcm:') || !key) throw new Error('Cannot decrypt secret');
  const raw = Buffer.from(stored.slice(4), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
