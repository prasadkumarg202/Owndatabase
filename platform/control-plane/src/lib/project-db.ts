/**
 * Per-project database connections.
 *
 * The SQL editor, EXPLAIN and table editor run as the project's own owner
 * role (never as the platform superuser), which confines them to the
 * project's schema.
 */
import postgres from 'postgres';
import { config } from '../config.js';
import { db } from './db.js';
import { open as vaultOpen, seal as vaultSeal } from './vault.js';
import { ownerRole } from './access.js';
import { generateDbPassword, provisionProjectSchema } from './provision.js';

const pools = new Map<string, { sql: postgres.Sql<any>; lastUsed: number }>();

export function projectConnectionUrl(schema: string, password: string, baseUrl = config.databaseUrl): string {
  const u = new URL(baseUrl);
  u.username = encodeURIComponent(ownerRole(schema));
  u.password = encodeURIComponent(password);
  return u.toString();
}

export async function getProjectDbPassword(projectId: string): Promise<string> {
  const [row] = await db<{ db_password_enc: string | null; db_schema: string }[]>`
    SELECT metadata->>'db_password_enc' AS db_password_enc, db_schema
    FROM control_plane.projects WHERE id = ${projectId}`;
  if (!row) throw new Error('Project not found');
  if (row.db_password_enc) return vaultOpen(projectId, 'db_password', row.db_password_enc);
  // Legacy project without an owner login yet → provision now
  return ensureProjectProvisioned(projectId, row.db_schema);
}

export async function ensureProjectProvisioned(projectId: string, schema: string): Promise<string> {
  const password = generateDbPassword();
  await provisionProjectSchema(schema, password);
  const enc = await vaultSeal(projectId, 'db_password', password);
  await db`
    UPDATE control_plane.projects
    SET metadata = metadata || ${db.json({ db_password_enc: enc })}
    WHERE id = ${projectId}`;
  pools.get(projectId)?.sql.end().catch(() => {});
  pools.delete(projectId);
  return password;
}

export async function projectDb(projectId: string, schema: string): Promise<postgres.Sql<any>> {
  const cached = pools.get(projectId);
  if (cached) { cached.lastUsed = Date.now(); return cached.sql; }
  const password = await getProjectDbPassword(projectId);
  const sql = postgres(projectConnectionUrl(schema, password), {
    max: 3,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'owndatabase-sql-editor' },
  });
  pools.set(projectId, { sql, lastUsed: Date.now() });
  return sql;
}

export async function closeProjectDb(projectId: string) {
  const p = pools.get(projectId);
  pools.delete(projectId);
  if (p) await p.sql.end({ timeout: 2 }).catch(() => {});
}

// Evict idle pools every minute
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, p] of pools) {
    if (p.lastUsed < cutoff) { pools.delete(id); p.sql.end({ timeout: 2 }).catch(() => {}); }
  }
}, 60_000).unref();
