/**
 * Least-privilege database logins for the services (migration 023, docs/security.md).
 * SERVICE_DB_PASSWORDS="odb_auth:<pw>,odb_api:<pw>,..." — the control API (superuser) sets each
 * role's password on start; a role without one stays NOLOGIN.
 */
import { db, ident, literal } from './db.js';
import { logger } from './logger.js';

const ROLES = new Set(['odb_auth', 'odb_api', 'odb_storage', 'odb_realtime', 'odb_worker', 'odb_cron']);

export async function ensureServiceRoles(): Promise<void> {
  const entries = (process.env['SERVICE_DB_PASSWORDS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const done: string[] = [];
  for (const entry of entries) {
    const i = entry.indexOf(':');
    const role = entry.slice(0, i), password = entry.slice(i + 1);
    if (!ROLES.has(role)) { logger.warn({ role }, 'SERVICE_DB_PASSWORDS: unknown role ignored'); continue; }
    if (password.length < 16) { logger.error({ role }, 'SERVICE_DB_PASSWORDS: password too short, role left NOLOGIN'); continue; }
    await db.unsafe(`ALTER ROLE ${ident(role)} WITH LOGIN PASSWORD ${literal(password)} CONNECTION LIMIT 200`);
    done.push(role);
  }
  logger.info({ roles: done }, 'Service database roles ready');
}
