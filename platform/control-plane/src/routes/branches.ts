/**
 * Branches: preview / development copies of a project.
 *
 *   GET    /api/projects/:id/branches
 *   POST   /api/projects/:id/branches                        { name, with_data? }
 *   POST   /api/projects/:id/branches/:branchId/merge        { dry_run? } apply the branch's own migrations to the parent
 *   DELETE /api/projects/:id/branches/:branchId
 *
 * A branch is a separate project in the same organization (own schema, keys,
 * end users and storage) created from the parent's current schema. It starts
 * with the parent's migration history, so `odb db push <branch>` adds only new
 * migrations, and merging applies exactly those to the parent.
 *
 * The schema is replayed as the branch's own owner role; with_data copies the
 * rows with psql connected as that role too (never as the platform superuser,
 * so user-defined triggers or defaults cannot run with elevated rights).
 * Secrets are not copied (they are often production credentials); the auth
 * settings, limits and functions are.
 */
import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { ADMIN_ROLES, audit, requireProject } from '../lib/access.js';
import { resealAuthSettings } from '../lib/vault.js';
import { getProjectDbPassword, projectConnectionUrl, projectDb } from '../lib/project-db.js';
import { pgDump, toMigration } from './migrations.js';
import { BRANCH_REQUEST_TOKEN } from '../lib/billing.js';

const s = (summary: string) => ({ schema: { tags: ['branches'], summary, security: [{ bearerAuth: [] }] } });
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,19}$/, 'Branch names use a-z, 0-9 and -, up to 20 characters');

/** DDL from pg_dump without triggers that call platform functions (webhooks/realtime are per project). */
function branchDdl(dump: string, schema: string): string {
  return toMigration(dump, schema).split('\n').filter((l) => !/^CREATE TRIGGER .*\bcontrol_plane\./.test(l)).join('\n');
}

/** Rewrites only statement lines (COPY … / setval), never row data. */
function retarget(dataDump: string, from: string, to: string): string {
  const q = [`"${from}".`, `${from}.`];
  return dataDump.split('\n')
    // keep the owner's search_path (its schema): triggers fired by the load use unqualified names
    .filter((l) => !/^SELECT pg_catalog\.set_config\('search_path', '', false\);/.test(l))
    .map((l) => {
    if (!/^(COPY |SELECT pg_catalog\.setval\()/.test(l)) return l;
    let out = l;
    for (const p of q) out = out.split(p).join(`"${to}".`);
    return out;
  }).join('\n');
}

function psql(url: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('psql', ['--no-psqlrc', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', url], { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(0, 800) || `psql exited ${code}`))));
    p.stdin.end(input);
  });
}

async function inject(server: FastifyInstance, request: FastifyRequest, method: 'POST' | 'DELETE', url: string, payload?: unknown) {
  const r = await server.inject({ method, url, payload: payload as any, headers: { authorization: String(request.headers.authorization ?? ''), 'x-odb-branch': BRANCH_REQUEST_TOKEN } });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
}

export const branchRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };

  server.get('/:id/branches', { ...auth, ...s('List branches') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id);
    if (!p) return;
    const rows = await db`
      SELECT b.id, b.name, b.slug, b.branch_name, b.status, b.created_at, b.api_endpoint,
             (SELECT count(*)::int FROM control_plane.project_migrations m WHERE m.project_id = b.id
                AND NOT EXISTS (SELECT 1 FROM control_plane.project_migrations pm WHERE pm.project_id = ${p.id} AND pm.version = m.version)) AS unmerged_migrations
      FROM control_plane.projects b WHERE b.parent_project_id = ${p.id} ORDER BY b.created_at`;
    return reply.send({ data: rows });
  });

  server.post('/:id/branches', { ...auth, ...s('Create a branch from this project') }, async (request, reply) => {
    const parent = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!parent) return;
    const input = z.object({ name: nameSchema, with_data: z.boolean().default(false) }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const [pp] = await db`SELECT * FROM control_plane.projects WHERE id = ${parent.id}`;
    if (pp!['parent_project_id']) return reply.status(400).send({ error: 'Validation Error', message: 'Create branches from the main project, not from a branch' });
    const [dup] = await db`SELECT 1 FROM control_plane.projects WHERE parent_project_id = ${parent.id} AND branch_name = ${input.data.name}`;
    if (dup) return reply.status(409).send({ error: 'Conflict', message: `Branch ${input.data.name} already exists` });

    // a regular project in the same organization (keys, provisioning, limits…)
    let slug = `${pp!['slug']}-${input.data.name}`.slice(0, 40).replace(/-+$/, '');
    const [taken] = await db`SELECT 1 FROM control_plane.projects WHERE organization_id = ${pp!['organization_id']} AND slug = ${slug}`;
    if (taken) slug = `${slug.slice(0, 34)}-${Math.random().toString(36).slice(2, 7)}`;
    const created = await inject(server, request, 'POST', '/api/projects', {
      name: `${pp!['name']} · ${input.data.name}`, slug, organization_id: pp!['organization_id'],
    });
    if (created.status !== 201) return reply.status(created.status).send(created.body);
    const branchId = created.body['id'] as string;
    const branchSchema = created.body['db_schema'] as string;

    const fail = async (stage: string, err: unknown) => {
      request.log.error({ err, branchId, stage }, 'Branch creation failed');
      await inject(server, request, 'DELETE', `/api/projects/${branchId}?confirm=${slug}`).catch(() => {});
      return reply.status(500).send({ error: 'Branch Failed', message: `${stage}: ${(err as Error).message}`.slice(0, 1000) });
    };

    try {
      // schema, as the branch owner, in one transaction
      const ddl = branchDdl(await pgDump(parent.db_schema), parent.db_schema);
      const bsql = await projectDb(branchId, branchSchema);
      await bsql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '10min'`);
        await tx.unsafe(ddl);
      });
    } catch (err) { return fail('Copying the schema', err); }

    if (input.data.with_data) {
      try {
        const data = retarget(await pgDump(parent.db_schema, 'data'), parent.db_schema, branchSchema);
        await psql(projectConnectionUrl(branchSchema, await getProjectDbPassword(branchId)), data);
      } catch (err) { return fail('Copying the data', err); }
    }

    // metadata: parent link, migration history, settings, functions
    // (auth secrets are bound to their project by the vault: re-seal the parent's for the branch)
    const branchAuth = await resealAuthSettings(parent.id, branchId, pp!['settings']?.['auth'] ?? {});
    await db.begin(async (sql) => {
      await sql`
        UPDATE control_plane.projects SET parent_project_id = ${parent.id}, branch_name = ${input.data.name},
          settings = settings || jsonb_build_object('auth', ${sql.json(branchAuth)}::jsonb,
                                                    'limits', ${sql.json(pp!['settings']?.['limits'] ?? {})}::jsonb)
        WHERE id = ${branchId}`;
      await sql`
        INSERT INTO control_plane.project_migrations (project_id, version, name, checksum, applied_at, source, sql)
        SELECT ${branchId}, version, name, checksum, applied_at, 'branch', sql FROM control_plane.project_migrations WHERE project_id = ${parent.id}`;
      await sql`
        INSERT INTO control_plane.functions (project_id, slug, name, code, timeout_ms, memory_mb, verify_jwt, created_by)
        SELECT ${branchId}, slug, name, code, timeout_ms, memory_mb, verify_jwt, created_by FROM control_plane.functions
        WHERE project_id = ${parent.id} AND is_active`;
    });
    await audit(request, 'branch.created', { type: 'project', id: branchId, projectId: parent.id }, { branch: input.data.name, with_data: input.data.with_data });
    return reply.status(201).send({ ...created.body, parent_project_id: parent.id, branch_name: input.data.name });
  });

  server.post('/:id/branches/:branchId/merge', { ...auth, ...s("Apply the branch's new migrations to this project") }, async (request, reply) => {
    const { id, branchId } = request.params as { id: string; branchId: string };
    const parent = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!parent) return;
    const branch = await ownBranch(id, branchId, reply);
    if (!branch) return;
    const { dry_run = false } = (request.body ?? {}) as { dry_run?: boolean };
    const pending = await db`
      SELECT version, name, sql FROM control_plane.project_migrations m
      WHERE m.project_id = ${branchId}
        AND NOT EXISTS (SELECT 1 FROM control_plane.project_migrations pm WHERE pm.project_id = ${id} AND pm.version = m.version)
      ORDER BY version`;
    const missing = pending.filter((m) => m['sql'] === null).map((m) => m['version']);
    if (missing.length) return reply.status(409).send({ error: 'Conflict', message: `Migrations without stored SQL cannot be merged: ${missing.join(', ')}` });
    const applied: string[] = [];
    for (const m of pending) {
      const r = await inject(server, request, 'POST', `/api/projects/${id}/migrations`, { version: m['version'], name: m['name'], sql: m['sql'], dry_run });
      if (r.status >= 300) {
        return reply.status(r.status === 409 ? 409 : 400).send({ error: 'Merge Failed', message: `${m['version']}_${m['name']}: ${r.body['message']}`, applied, failed: m['version'] });
      }
      applied.push(m['version'] as string);
      if (dry_run) break; // later migrations may depend on this one
    }
    if (!dry_run && applied.length) await audit(request, 'branch.merged', { type: 'project', id: branchId, projectId: id }, { applied });
    return reply.send({ applied, dry_run });
  });

  server.delete('/:id/branches/:branchId', { ...auth, ...s('Delete a branch') }, async (request, reply) => {
    const { id, branchId } = request.params as { id: string; branchId: string };
    const parent = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!parent) return;
    const branch = await ownBranch(id, branchId, reply);
    if (!branch) return;
    const r = await inject(server, request, 'DELETE', `/api/projects/${branchId}?confirm=${branch['slug']}`);
    return reply.status(r.status).send(r.body);
  });

  async function ownBranch(parentId: string, branchId: string, reply: FastifyReply) {
    if (!/^[0-9a-f-]{36}$/i.test(branchId)) { reply.status(404).send({ error: 'Not Found', message: 'Branch not found' }); return null; }
    const [b] = await db`SELECT id, slug FROM control_plane.projects WHERE id = ${branchId} AND parent_project_id = ${parentId}`;
    if (!b) { reply.status(404).send({ error: 'Not Found', message: 'Branch not found' }); return null; }
    return b;
  }
};
