/**
 * MFA seed encryption. The key is the project's MFA key from the vault (docs/vault.md); this service
 * holds no encryption key of its own. Seeds are "mfa1:<base64 iv|tag|ciphertext>", bound to the
 * project and user (AAD), so a seed cannot be moved to another account.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { vault } from './vault.js';

const aad = (projectId: string, userId: string) => Buffer.from(`odb-mfa\0${projectId}\0${userId}`, 'utf8');
const key = async (projectId: string) => Buffer.from((await vault.reveal(projectId, 'mfa_key'))['mfa_key'] ?? '', 'hex');

export async function sealMfa(projectId: string, userId: string, plain: string): Promise<string> {
  const k = await key(projectId);
  if (k.length !== 32) throw new Error('MFA key unavailable');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(aad(projectId, userId));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `mfa1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export async function unsealMfa(projectId: string, userId: string, stored: string): Promise<string> {
  // seeds from before the vault are converted by the control API on start
  if (!stored.startsWith('mfa1:')) throw new Error('MFA seed is not in vault format yet');
  const raw = Buffer.from(stored.slice(5), 'base64');
  const d = createDecipheriv('aes-256-gcm', await key(projectId), raw.subarray(0, 12));
  d.setAAD(aad(projectId, userId));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
