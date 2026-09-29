/**
 * Per-project schema migrations (the server side of `odb db push / pull / reset`).
 *
 *   GET    /api/projects/:id/migrations                 — applied migrations
 *   POST   /api/projects/:id/migrations                 — apply { version, name, sql, dry_run? }
 *   POST   /api/projects/:id/migrations/repair          — { version, status: applied|reverted, name?, sql? }
 *   GET    /api/projects/:id/migrations/remote-schema   — schema DDL (pg_dump), for `db pull`
 *   POST   /api/projects/:id/database/reset             — { confirm: <slug> } drop everything in the schema
 *
 * A migration runs in ONE transaction on the project's owner-role connection
 * (never as the platform superuser, so RESET ROLE cannot escalate) and is
 * recorded in the same transaction via odb_meta.record_migration(), so it is
 * either applied and recorded, or neither.
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { ADMIN_ROLES, WRITE_ROLES, audit, requireProject, userId } from '../lib/access.js';
import { closeProjectDb, getProjectDbPassword, projectDb } from '../lib/project-db.js';
import { provisionProjectSchema } from '../lib/provision.js';

const s = (summary: string) => ({ schema: { tags: ['migrations'], summary, security: [{ bearerAuth: [] }] } });
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const versionSchema = z.string().regex(/^[0-9]{1,32}$/, 'version must be digits, e.g. 20260929153000');
const MIGRATION_TIMEOUT = '10min';

class DryRun extends Error {}

// Transaction control would break "applied and recorded together"
const TXN_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b|\bCONCURRENTLY\b/im;

/** SQL outside function bodies, strings and comments (PL/pgSQL bodies legitimately contain BEGIN). */
function stripComments(sql: string) {
  return sql
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

async function schemaChanged(projectId: string) {
  await redis.publish('odb:schema-changed', JSON.stringify({ projectId })).catch(() => {});
}

export function pgDump(schema: string, mode: 'schema' | 'data' = 'schema'): Promise<string> {
  const u = new URL(config.databaseUrl);
  return new Promise((resolve, reject) => {
    const p = spawn('pg_dump', [mode === 'schema' ? '--schema-only' : '--data-only', '--no-owner', '--no-acl', '--no-comments', '--schema', schema, '--dbname', u.pathname.slice(1)], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`pg_dump exited ${code}: ${err.slice(0, 500)}`))));
  });
}

/**
 * Makes a pg_dump of one schema replayable as a migration in any project:
 * drops session SETs and CREATE SCHEMA, and removes the schema qualifier
 * (migrations run with search_path = the project's schema).
 */
export function toMigration(dump: string, schema: string): string {
  const q = [`"${schema}".`, `${schema}.`];
  const lines = dump.split('\n').filter((l) =>
    !/^--/.test(l) && // pg_dump's table-of-contents comments name the source schema
    !/^SET /.test(l) && !/^SELECT pg_catalog\.set_config\('search_path'/.test(l) && !/^CREATE SCHEMA /.test(l) && !/^ALTER SCHEMA /.test(l) && !/^\\(un)?restrict /.test(l));
  let out = lines.join('\n');
  for (const prefix of q) out = out.split(prefix).join('');
  return `-- Schema pulled from the project on ${new Date().toISOString()}\n\n` + out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export const migrationRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };

  server.get('/:id/migrations', { ...auth, ...s('Applied migrations') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id);
    if (!p) return;
    const rows = await db`
      SELECT m.version, m.name, m.checksum, m.applied_at, m.execution_ms, m.source, pu.email AS applied_by
      FROM control_plane.project_migrations m LEFT JOIN control_plane.platform_users pu ON pu.id = m.applied_by
      WHERE m.project_id = ${p.id} ORDER BY m.version`;
    return reply.send({ data: rows });
  });

  server.post('/:id/migrations', { ...auth, ...s('Apply a migration') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, WRITE_ROLES);
    if (!p) return;
    const input = z.object({
      version: versionSchema,
      name: z.string().max(200).default(''),
      sql: z.string().min(1).max(5_000_000),
      dry_run: z.boolean().default(false),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const m = input.data;
    const checksum = sha256(m.sql);

    const [existing] = await db`SELECT checksum FROM control_plane.project_migrations WHERE project_id = ${p.id} AND version = ${m.version}`;
    if (existing) {
      if (existing['checksum'] === checksum) return reply.send({ version: m.version, status: 'already_applied' });
      return reply.status(409).send({ error: 'Conflict', message: `Migration ${m.version} was already applied with different contents. Create a new migration instead of editing an applied one.` });
    }
    if (TXN_CONTROL.test(stripComments(m.sql))) {
      return reply.status(400).send({ error: 'Validation Error', message: 'Migrations run in one transaction: remove BEGIN/COMMIT/ROLLBACK/SAVEPOINT and CONCURRENTLY' });
    }

    const sql = await projectDb(p.id, p.db_schema);
    const started = Date.now();
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${MIGRATION_TIMEOUT}'`);
        await tx.unsafe(`SET LOCAL lock_timeout = '15s'`);
        await tx.unsafe(m.sql);
        await tx`SELECT odb_meta.record_migration(${m.version}, ${m.name}, ${checksum})`;
        if (m.dry_run) throw new DryRun();
      });
    } catch (err) {
      if (err instanceof DryRun) return reply.send({ version: m.version, status: 'ok', dry_run: true, execution_ms: Date.now() - started });
      const e = err as any;
      return reply.status(400).send({
        error: 'Migration Failed', message: e.message ?? String(err), code: e.code, position: e.position, hint: e.hint, detail: e.detail,
        note: 'Nothing was applied (the migration ran in a transaction).',
      });
    }
    const ms = Date.now() - started;
    await db`UPDATE control_plane.project_migrations SET applied_by = ${userId(request)}, execution_ms = ${ms}, sql = ${m.sql}
             WHERE project_id = ${p.id} AND version = ${m.version}`;
    await schemaChanged(p.id);
    await audit(request, 'migration.applied', { type: 'migration', id: m.version, projectId: p.id }, { name: m.name, checksum, execution_ms: ms });
    return reply.status(201).send({ version: m.version, name: m.name, status: 'applied', execution_ms: ms });
  });

  server.post('/:id/migrations/repair', { ...auth, ...s('Mark a migration applied or reverted without running it') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!p) return;
    const input = z.object({
      version: versionSchema, status: z.enum(['applied', 'reverted']),
      name: z.string().max(200).default(''), sql: z.string().max(5_000_000).optional(), source: z.enum(['repair', 'pull']).default('repair'),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const r = input.data;
    if (r.status === 'applied') {
      await db`
        INSERT INTO control_plane.project_migrations (project_id, version, name, checksum, applied_by, source, sql)
        VALUES (${p.id}, ${r.version}, ${r.name}, ${sha256(r.sql ?? '')}, ${userId(request)}, ${r.source}, ${r.sql ?? null})
        ON CONFLICT (project_id, version) DO UPDATE SET name = EXCLUDED.name, checksum = EXCLUDED.checksum, source = EXCLUDED.source, sql = EXCLUDED.sql`;
    } else {
      await db`DELETE FROM control_plane.project_migrations WHERE project_id = ${p.id} AND version = ${r.version}`;
    }
    await audit(request, 'migration.repaired', { type: 'migration', id: r.version, projectId: p.id }, { status: r.status, source: r.source });
    return reply.send({ version: r.version, status: r.status });
  });

  server.get('/:id/migrations/remote-schema', { ...auth, ...s('Schema DDL as a migration (for db pull)') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, WRITE_ROLES);
    if (!p) return;
    try {
      const dump = await pgDump(p.db_schema);
      return reply.send({ schema: p.db_schema, sql: toMigration(dump, p.db_schema) });
    } catch (err) {
      request.log.error({ err }, 'pg_dump failed');
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Could not dump the schema' });
    }
  });

  server.post('/:id/database/reset', { ...auth, ...s('Drop every object in the project schema (keeps auth users and storage)') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const [proj] = await db`SELECT slug, db_schema FROM control_plane.projects WHERE id = ${id}`;
    const { confirm } = (request.body ?? {}) as { confirm?: string };
    if (confirm !== proj!['slug']) {
      return reply.status(400).send({ error: 'Confirmation Required', message: `This deletes every table, view and function in the project. Send { "confirm": "${proj!['slug']}" }.` });
    }
    const schema = proj!['db_schema'] as string;
    const password = await getProjectDbPassword(id);
    await closeProjectDb(id);
    // no user SQL runs here: drop the schema as the platform and provision it again
    await db.unsafe(`DROP SCHEMA IF EXISTS "${schema.replace(/"/g, '""')}" CASCADE`);
    await provisionProjectSchema(schema, password);
    await db`DELETE FROM control_plane.project_migrations WHERE project_id = ${id}`;
    await schemaChanged(id);
    await audit(request, 'database.reset', { type: 'project', id, projectId: id });
    return reply.send({ success: true, message: 'The project schema is empty. Push your migrations to rebuild it.' });
  });
};
