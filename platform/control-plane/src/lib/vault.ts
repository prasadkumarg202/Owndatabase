/**
 * Secrets vault — envelope encryption for every secret the platform stores (docs/vault.md).
 *
 *   master keys (KEKs)      VAULT_MASTER_KEYS="k2:<64 hex>,k1:<64 hex>" — first = active. Only the control API has them.
 *     └ data keys (DEKs)    one per project (scope), stored wrapped in control_plane.vault_keys
 *         └ secrets         "vault:v1:<dek id>:<base64 iv|tag|ciphertext>", AAD = scope + secret name,
 *                           so a ciphertext cannot be moved to another project or field
 *
 * Rotating a master key re-wraps the data keys (no secret is re-encrypted); rotating a project's
 * data key re-encrypts that project's secrets. Services never get a key: they ask
 * POST /api/internal/vault/reveal with their own token for the kinds of secret they need.
 *
 * Without VAULT_MASTER_KEYS the master key "k0" is derived from SECRET_ENCRYPTION_KEY (HKDF), and it
 * always stays available to unwrap older data keys. Values written before the vault ("legacy":
 * AES-GCM directly under SECRET_ENCRYPTION_KEY, or plaintext in project settings) are converted by
 * migrateAll() on start.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '../config.js';
import { db, type Sql } from './db.js';
import { logger } from './logger.js';

type Tx = Sql | postgres.TransactionSql<Record<string, unknown>>;

const PREFIX = 'vault:v1:';
interface Kek { id: string; key: Buffer }

function loadKeyring(): Kek[] {
  const keys: Kek[] = [];
  for (const entry of (process.env['VAULT_MASTER_KEYS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, hex] = entry.split(':');
    if (!id || !/^[a-z0-9_-]{1,32}$/i.test(id) || !hex || !/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error('VAULT_MASTER_KEYS must be "id:<64 hex chars>", comma-separated');
    }
    if (keys.some((k) => k.id === id)) throw new Error(`VAULT_MASTER_KEYS lists "${id}" twice`);
    keys.push({ id, key: Buffer.from(hex, 'hex') });
  }
  if (!keys.some((k) => k.id === 'k0')) {
    const k0 = Buffer.from(hkdfSync('sha256', Buffer.from(config.secretEncryptionKey, 'hex'), Buffer.alloc(0), 'owndatabase-vault-kek', 32));
    keys.push({ id: 'k0', key: k0 });
  }
  return keys;
}
const keyring = loadKeyring();
export const activeKekId = () => keyring[0]!.id;
const kek = (id: string) => {
  const k = keyring.find((x) => x.id === id);
  if (!k) throw new Error(`Vault master key "${id}" is not configured (VAULT_MASTER_KEYS)`);
  return k.key;
};

function gcmSeal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function gcmOpen(key: Buffer, raw: Buffer, aad?: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  if (aad !== undefined) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}
const dekAad = (scope: string, version: number) => `odb-dek\0${scope}\0${version}`;
const secretAad = (scope: string, name: string) => `odb-secret\0${scope}\0${name}`;

// unwrapped data keys (immutable once created)
const dekCache = new Map<string, { scope: string; key: Buffer }>();

async function loadDek(sql: Tx, id: string): Promise<{ scope: string; key: Buffer }> {
  const hit = dekCache.get(id);
  if (hit) return hit;
  const [row] = await sql`SELECT scope, version, kek_id, wrapped_key FROM control_plane.vault_keys WHERE id = ${id}`;
  if (!row) throw new Error('Vault data key not found');
  const key = gcmOpen(kek(row['kek_id'] as string), row['wrapped_key'] as Buffer, dekAad(row['scope'] as string, row['version'] as number));
  const v = { scope: row['scope'] as string, key };
  dekCache.set(id, v);
  return v;
}

async function activeDek(sql: Tx, scope: string): Promise<{ id: string; key: Buffer }> {
  const find = async () => {
    const [row] = await sql`SELECT id FROM control_plane.vault_keys WHERE scope = ${scope} AND status = 'active'`;
    return row ? { id: row['id'] as string, key: (await loadDek(sql, row['id'] as string)).key } : null;
  };
  const found = await find();
  if (found) return found;
  const key = randomBytes(32);
  await sql`
    INSERT INTO control_plane.vault_keys (scope, version, kek_id, wrapped_key)
    VALUES (${scope}, 1, ${activeKekId()}, ${gcmSeal(kek(activeKekId()), key, dekAad(scope, 1))})
    ON CONFLICT DO NOTHING`;
  const created = await find();
  if (!created) throw new Error('Could not create a vault data key');
  return created;
}

export const isSealed = (v: unknown): boolean =>
  (typeof v === 'string' && v.startsWith(PREFIX)) || (Buffer.isBuffer(v) && v.subarray(0, PREFIX.length).toString('utf8') === PREFIX);

/** Encrypts a secret for a project (scope) under a field name. */
export async function seal(scope: string, name: string, plaintext: string, sql: Tx = db): Promise<string> {
  const dek = await activeDek(sql, scope);
  return `${PREFIX}${dek.id}:${gcmSeal(dek.key, Buffer.from(plaintext, 'utf8'), secretAad(scope, name)).toString('base64')}`;
}
/** seal() for bytea columns */
export const sealBytes = async (scope: string, name: string, plaintext: string, sql: Tx = db) => Buffer.from(await seal(scope, name, plaintext, sql), 'utf8');

/**
 * Decrypts a stored value: a vault string (or its bytes), or a legacy value —
 * AES-GCM under SECRET_ENCRYPTION_KEY as bytes or hex.
 */
export async function open(scope: string, name: string, stored: string | Buffer, sql: Tx = db): Promise<string> {
  const s = Buffer.isBuffer(stored) ? (isSealed(stored) ? stored.toString('utf8') : null) : stored;
  if (s !== null && s.startsWith(PREFIX)) {
    const rest = s.slice(PREFIX.length);
    const i = rest.indexOf(':');
    const dek = await loadDek(sql, rest.slice(0, i));
    if (dek.scope !== scope) throw new Error('Vault secret belongs to another scope');
    return gcmOpen(dek.key, Buffer.from(rest.slice(i + 1), 'base64'), secretAad(scope, name)).toString('utf8');
  }
  const raw = Buffer.isBuffer(stored) ? stored : Buffer.from(stored, 'hex');
  return gcmOpen(Buffer.from(config.secretEncryptionKey, 'hex'), raw).toString('utf8');
}

// ── where secrets live ─────────────────────────────────────────────────────────

/** Secret fields inside projects.settings.auth, as [path, vault name]. */
export function authSecretPaths(auth: any): [string[], string][] {
  const out: [string[], string][] = [];
  for (const p of Object.keys(auth?.providers ?? {})) out.push([['providers', p, 'client_secret'], `auth.providers.${p}.client_secret`]);
  out.push([['sms', 'twilio_auth_token'], 'auth.sms.twilio_auth_token']);
  out.push([['sms', 'webhook_secret'], 'auth.sms.webhook_secret']);
  out.push([['captcha', 'secret'], 'auth.captcha.secret']);
  return out;
}
const getPath = (o: any, path: string[]) => path.reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (o: any, path: string[], v: unknown) => {
  let cur = o;
  for (const k of path.slice(0, -1)) cur = cur[k] ??= {};
  cur[path[path.length - 1]!] = v;
};

/** Seals every non-empty, not-yet-sealed secret in an auth settings object (in place). */
export async function sealAuthSettings(projectId: string, auth: any, sql: Tx = db): Promise<number> {
  let n = 0;
  for (const [path, name] of authSecretPaths(auth)) {
    const v = getPath(auth, path);
    if (typeof v === 'string' && v !== '' && !isSealed(v)) { setPath(auth, path, await seal(projectId, name, v, sql)); n++; }
  }
  return n;
}

/** A copy of `auth` with its secrets re-sealed from one project to another (branches). */
export async function resealAuthSettings(fromScope: string, toScope: string, auth: any): Promise<any> {
  const copy = JSON.parse(JSON.stringify(auth ?? {}));
  for (const [path, name] of authSecretPaths(copy)) {
    const v = getPath(copy, path);
    if (typeof v === 'string' && v !== '') setPath(copy, path, await seal(toScope, name, isSealed(v) ? await open(fromScope, name, v) : v));
  }
  return copy;
}

/** Decrypted auth secrets of a project: { 'auth.providers.google.client_secret': '...' } */
export async function openAuthSettings(projectId: string, auth: any, sql: Tx = db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, name] of authSecretPaths(auth)) {
    const v = getPath(auth, path);
    if (typeof v === 'string' && v !== '') out[name] = isSealed(v) ? await open(projectId, name, v, sql) : v;
  }
  return out;
}

/**
 * Re-encrypts every secret of a project with `reseal(name, current) => new stored value`.
 * Covers auth settings, function secrets, database-webhook secrets and the project's DB password.
 */
async function resealProject(sql: Tx, projectId: string, onlyUnsealed: boolean): Promise<number> {
  let n = 0;
  const [p] = await sql`SELECT settings, metadata FROM control_plane.projects WHERE id = ${projectId} FOR UPDATE`;
  if (!p) return 0;
  const settings = (p['settings'] ?? {}) as any;
  if (settings.auth) {
    let changed = false;
    for (const [path, name] of authSecretPaths(settings.auth)) {
      const v = getPath(settings.auth, path);
      if (typeof v !== 'string' || v === '' || (onlyUnsealed && isSealed(v))) continue;
      const plain = isSealed(v) ? await open(projectId, name, v, sql) : v;
      setPath(settings.auth, path, await seal(projectId, name, plain, sql));
      changed = true; n++;
    }
    if (changed) await sql`UPDATE control_plane.projects SET settings = jsonb_set(settings, '{auth}', ${sql.json(settings.auth)}) WHERE id = ${projectId}`;
  }
  const meta = (p['metadata'] ?? {}) as any;
  for (const [field, name] of [['db_password_enc', 'db_password'], ['mfa_key_enc', 'auth.mfa_key']] as const) {
    if (typeof meta[field] !== 'string' || (onlyUnsealed && isSealed(meta[field]))) continue;
    const plain = await open(projectId, name, meta[field], sql);
    await sql`UPDATE control_plane.projects SET metadata = metadata || ${sql.json({ [field]: await seal(projectId, name, plain, sql) })} WHERE id = ${projectId}`;
    n++;
  }
  for (const r of await sql`SELECT id, name, value_encrypted FROM control_plane.secrets WHERE project_id = ${projectId}`) {
    const v = r['value_encrypted'] as Buffer;
    if (onlyUnsealed && isSealed(v)) continue;
    let plain: string;
    try { plain = await open(projectId, `function_secret:${r['name']}`, v, sql); } catch (err) {
      logger.error({ err, projectId, secret: r['name'] }, 'vault: cannot decrypt a function secret, left unchanged');
      continue;
    }
    await sql`UPDATE control_plane.secrets SET value_encrypted = ${await sealBytes(projectId, `function_secret:${r['name']}`, plain, sql)} WHERE id = ${r['id'] as string}`;
    n++;
  }
  // log drain secrets are always sealed: re-seal them on data-key rotation
  if (!onlyUnsealed) {
    for (const r of await sql`SELECT id, secret_sealed FROM control_plane.log_drains WHERE project_id = ${projectId} AND secret_sealed IS NOT NULL`) {
      const name = `log_drain:${r['id']}`;
      await sql`UPDATE control_plane.log_drains SET secret_sealed = ${await seal(projectId, name, await open(projectId, name, r['secret_sealed'] as string, sql), sql)} WHERE id = ${r['id'] as string}`;
      n++;
    }
  }
  for (const r of await sql`SELECT id, secret_encrypted FROM control_plane.db_webhooks WHERE project_id = ${projectId} AND secret_encrypted IS NOT NULL`) {
    const v = r['secret_encrypted'] as Buffer;
    if (onlyUnsealed && isSealed(v)) continue;
    let plain: string;
    try { plain = await open(projectId, `db_webhook:${r['id']}`, v, sql); } catch (err) {
      logger.error({ err, projectId, hook: r['id'] }, 'vault: cannot decrypt a webhook secret, left unchanged');
      continue;
    }
    await sql`UPDATE control_plane.db_webhooks SET secret_encrypted = ${await sealBytes(projectId, `db_webhook:${r['id']}`, plain, sql)} WHERE id = ${r['id'] as string}`;
    n++;
  }
  return n;
}

// ── MFA seeds ──────────────────────────────────────────────────────────────────
// TOTP seeds are checked on every MFA sign-in, so the auth service gets a per-project MFA key from the
// vault (kind 'mfa_key') and seals each seed with it, bound to the project and user:
// "mfa1:<base64 iv|tag|ciphertext>", AAD = project + user.

/** The project's MFA key (hex), created on first use; stored sealed in projects.metadata.mfa_key_enc. */
export async function projectMfaKey(projectId: string, sql: Tx = db): Promise<string> {
  const read = async () => (await sql`SELECT metadata->>'mfa_key_enc' AS k FROM control_plane.projects WHERE id = ${projectId}`)[0]?.['k'] as string | null | undefined;
  let stored = await read();
  if (!stored) {
    const fresh = await seal(projectId, 'auth.mfa_key', randomBytes(32).toString('hex'), sql);
    await sql`UPDATE control_plane.projects SET metadata = metadata || ${sql.json({ mfa_key_enc: fresh })}
              WHERE id = ${projectId} AND NOT (metadata ? 'mfa_key_enc')`;
    stored = await read();
    if (!stored) throw new Error('Project not found');
  }
  return open(projectId, 'auth.mfa_key', stored, sql);
}

const mfaAad = (projectId: string, userId: string) => `odb-mfa\0${projectId}\0${userId}`;
export function mfaSeal(keyHex: string, projectId: string, userId: string, plain: string): string {
  return `mfa1:${gcmSeal(Buffer.from(keyHex, 'hex'), Buffer.from(plain, 'utf8'), mfaAad(projectId, userId)).toString('base64')}`;
}

/** Converts seeds sealed with SECRET_ENCRYPTION_KEY ("gcm:" / "plain:", before the vault) to mfa1. */
async function migrateMfaSeeds(): Promise<number> {
  const rows = await db`
    SELECT f.id, f.user_id, f.secret, u.project_id FROM auth.mfa_factors f JOIN auth.users u ON u.id = f.user_id
    WHERE f.secret LIKE 'gcm:%' OR f.secret LIKE 'plain:%'`;
  const keys = new Map<string, string>();
  let n = 0;
  for (const r of rows) {
    const pid = r['project_id'] as string, uid = r['user_id'] as string, s = r['secret'] as string;
    try {
      const plain = s.startsWith('plain:') ? s.slice(6) : gcmOpen(Buffer.from(config.secretEncryptionKey, 'hex'), Buffer.from(s.slice(4), 'base64')).toString('utf8');
      if (!keys.has(pid)) keys.set(pid, await projectMfaKey(pid));
      await db`UPDATE auth.mfa_factors SET secret = ${mfaSeal(keys.get(pid)!, pid, uid, plain)} WHERE id = ${r['id'] as string} AND secret = ${s}`;
      n++;
    } catch (err) {
      logger.error({ err, factor: r['id'] }, 'vault: cannot convert an MFA seed, left unchanged');
    }
  }
  return n;
}

export async function vaultAudit(actor: string, action: string, projectId: string | null, detail: Record<string, unknown> = {}, ip: string | null = null, sql: Tx = db) {
  await sql`INSERT INTO control_plane.vault_audit (actor, project_id, action, detail, ip) VALUES (${actor}, ${projectId}, ${action}, ${sql.json(detail as any)}, ${ip})`;
}

/** New data key for a project, all its secrets re-encrypted with it, the old key retired. */
export async function rotateProjectKey(projectId: string, actor: string, ip: string | null = null): Promise<{ version: number; secrets: number }> {
  return db.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${'vault:' + projectId}))`;
    const [cur] = await sql`SELECT id, version FROM control_plane.vault_keys WHERE scope = ${projectId} AND status = 'active'`;
    const version = ((cur?.['version'] as number | undefined) ?? 0) + 1;
    if (cur) await sql`UPDATE control_plane.vault_keys SET status = 'retired', retired_at = NOW() WHERE id = ${cur['id'] as string}`;
    const key = randomBytes(32);
    await sql`
      INSERT INTO control_plane.vault_keys (scope, version, kek_id, wrapped_key)
      VALUES (${projectId}, ${version}, ${activeKekId()}, ${gcmSeal(kek(activeKekId()), key, dekAad(projectId, version))})`;
    const secrets = await resealProject(sql, projectId, false);
    await vaultAudit(actor, 'rotate_project_key', projectId, { version, secrets }, ip, sql);
    return { version, secrets };
  });
}

/** Re-wraps every data key not wrapped by the active master key. */
export async function rotateMasterKey(actor: string, ip: string | null = null): Promise<{ rewrapped: number; kek: string }> {
  const active = activeKekId();
  let rewrapped = 0;
  for (const r of await db`SELECT id, scope, version, kek_id, wrapped_key FROM control_plane.vault_keys WHERE kek_id <> ${active}`) {
    const aad = dekAad(r['scope'] as string, r['version'] as number);
    const key = gcmOpen(kek(r['kek_id'] as string), r['wrapped_key'] as Buffer, aad);
    await db`UPDATE control_plane.vault_keys SET kek_id = ${active}, wrapped_key = ${gcmSeal(kek(active), key, aad)} WHERE id = ${r['id'] as string} AND kek_id = ${r['kek_id'] as string}`;
    rewrapped++;
  }
  if (rewrapped) await vaultAudit(actor, 'rotate_master_key', null, { rewrapped, kek: active }, ip);
  return { rewrapped, kek: active };
}

/** On start: re-wrap data keys to the active master key and seal plaintext / legacy secrets. */
export async function migrateAll(): Promise<void> {
  try {
    const { rewrapped } = await rotateMasterKey('system');
    const projects = await db`
      SELECT DISTINCT p.id FROM control_plane.projects p
      LEFT JOIN control_plane.secrets s ON s.project_id = p.id
      LEFT JOIN control_plane.db_webhooks w ON w.project_id = p.id AND w.secret_encrypted IS NOT NULL
      WHERE p.settings ? 'auth' OR p.metadata ? 'db_password_enc' OR p.metadata ? 'mfa_key_enc' OR s.id IS NOT NULL OR w.id IS NOT NULL`;
    let sealed = 0;
    for (const p of projects) {
      sealed += await db.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${'vault:' + (p['id'] as string)}))`;
        return resealProject(sql, p['id'] as string, true);
      });
    }
    const mfa = await migrateMfaSeeds();
    if (sealed || mfa) await vaultAudit('system', 'migrate', null, { sealed, mfa_seeds: mfa, projects: projects.length });
    logger.info({ rewrapped, sealed, mfa_seeds: mfa, kek: activeKekId() }, 'Vault ready');
  } catch (err) {
    logger.error({ err }, 'Vault migration failed');
  }
}

export async function vaultStatus() {
  const byKek = await db`SELECT kek_id, status, count(*)::int AS n FROM control_plane.vault_keys GROUP BY 1, 2 ORDER BY 1, 2`;
  const [plain] = await db`
    SELECT
      (SELECT count(*)::int FROM control_plane.secrets WHERE substring(value_encrypted from 1 for 9) <> convert_to('vault:v1:', 'UTF8')) AS function_secrets,
      (SELECT count(*)::int FROM control_plane.db_webhooks WHERE secret_encrypted IS NOT NULL AND substring(secret_encrypted from 1 for 9) <> convert_to('vault:v1:', 'UTF8')) AS webhook_secrets,
      (SELECT count(*)::int FROM control_plane.projects WHERE metadata ? 'db_password_enc' AND metadata->>'db_password_enc' NOT LIKE 'vault:v1:%') AS db_passwords,
      (SELECT count(*)::int FROM auth.mfa_factors WHERE secret NOT LIKE 'mfa1:%') AS mfa_seeds`;
  return {
    active_master_key: activeKekId(),
    configured_master_keys: keyring.map((k) => k.id),
    master_key_source: process.env['VAULT_MASTER_KEYS'] ? 'VAULT_MASTER_KEYS' : 'derived from SECRET_ENCRYPTION_KEY',
    data_keys: byKek,
    not_in_vault_format: plain,
  };
}
