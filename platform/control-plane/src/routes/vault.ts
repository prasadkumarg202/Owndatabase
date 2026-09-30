/**
 * Secrets vault routes (docs/vault.md)
 *
 *   POST /api/internal/vault/reveal            services only (Bearer <service token>); blocked at the gateway
 *   GET  /api/projects/:id/vault               data-key version + recent vault audit (project members)
 *   POST /api/projects/:id/vault/rotate        new data key, all project secrets re-encrypted (owners / admins)
 *   GET  /api/admin/vault                      master keys, data keys, anything not yet in vault format
 *   POST /api/admin/vault/rotate-master-key    re-wrap every data key with the active master key
 *   GET  /api/admin/vault/audit?project_id=    vault audit log
 */
import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { ADMIN_ROLES, audit, requirePlatformAdmin, requireProject, userId } from '../lib/access.js';
import { open, openAuthSettings, projectMfaKey, rotateMasterKey, rotateProjectKey, vaultAudit, vaultStatus } from '../lib/vault.js';
import { redis } from '../lib/redis.js';

/** Which kinds of secret each service may read. */
const POLICY: Record<string, readonly string[]> = {
  'auth-service': ['auth', 'mfa_key'],
  'api-service': ['function_secrets'],
  'queue-worker': ['db_password', 'db_webhook', 'log_drain'],
};

function serviceTokens(): { service: string; token: Buffer }[] {
  return (process.env['VAULT_SERVICE_TOKENS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const i = entry.indexOf(':');
    return { service: entry.slice(0, i), token: Buffer.from(entry.slice(i + 1)) };
  }).filter((t) => t.service && t.token.length >= 32);
}
const TOKENS = serviceTokens();

function callingService(request: FastifyRequest): string | null {
  const h = request.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const got = Buffer.from(h.slice(7));
  let found: string | null = null;
  for (const t of TOKENS) if (t.token.length === got.length && timingSafeEqual(t.token, got)) found = t.service;
  return found;
}

const revealSchema = z.object({
  project_id: z.string().uuid(),
  kind: z.enum(['auth', 'mfa_key', 'function_secrets', 'db_password', 'db_webhook', 'log_drain']),
  id: z.string().uuid().optional(),
});

export const vaultInternalRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.post('/vault/reveal', async (request, reply) => {
    const service = callingService(request);
    if (!service) return reply.status(401).send({ error: 'Unauthorized', message: 'A vault service token is required' });
    const input = revealSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const { project_id: pid, kind, id } = input.data;
    if (!POLICY[service]?.includes(kind)) {
      await vaultAudit(service, 'reveal_denied', pid, { kind }, request.ip);
      return reply.status(403).send({ error: 'Forbidden', message: `${service} may not read ${kind} secrets` });
    }
    const [p] = await db`SELECT settings->'auth' AS auth, metadata->>'db_password_enc' AS pw FROM control_plane.projects WHERE id = ${pid}`;
    if (!p) return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });

    let secrets: Record<string, string> = {};
    if (kind === 'auth') secrets = await openAuthSettings(pid, p['auth'] ?? {});
    else if (kind === 'mfa_key') secrets['mfa_key'] = await projectMfaKey(pid);
    else if (kind === 'db_password') {
      if (p['pw']) secrets['db_password'] = await open(pid, 'db_password', p['pw'] as string);
    } else if (kind === 'function_secrets') {
      for (const r of await db`SELECT name, value_encrypted FROM control_plane.secrets WHERE project_id = ${pid} AND is_active`) {
        try { secrets[r['name'] as string] = await open(pid, `function_secret:${r['name']}`, r['value_encrypted'] as Buffer); } catch (err) {
          request.log.error({ err, projectId: pid, secret: r['name'] }, 'vault: cannot decrypt function secret');
        }
      }
    } else if (kind === 'log_drain') {
      if (!id) return reply.status(400).send({ error: 'Validation Error', message: 'id is required for log_drain' });
      const [d] = await db`SELECT secret_sealed FROM control_plane.log_drains WHERE id = ${id} AND project_id = ${pid}`;
      if (d?.['secret_sealed']) secrets['secret'] = await open(pid, `log_drain:${id}`, d['secret_sealed'] as string);
    } else if (kind === 'db_webhook') {
      if (!id) return reply.status(400).send({ error: 'Validation Error', message: 'id is required for db_webhook' });
      const [h] = await db`SELECT secret_encrypted FROM control_plane.db_webhooks WHERE id = ${id} AND project_id = ${pid}`;
      if (h?.['secret_encrypted']) secrets['secret'] = await open(pid, `db_webhook:${id}`, h['secret_encrypted'] as Buffer);
    }
    await vaultAudit(service, 'reveal', pid, { kind, ...(id ? { id } : {}), names: Object.keys(secrets) }, request.ip);
    return reply.header('cache-control', 'no-store').send({ secrets });
  });
};

export const vaultRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const tags = { tags: ['vault'], security: [{ bearerAuth: [] }] };

  server.get('/api/projects/:id/vault', { ...auth, schema: { ...tags, summary: 'Data key and vault audit for a project' } }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id);
    if (!p) return;
    const keys = await db`SELECT version, kek_id AS master_key, status, created_at, retired_at FROM control_plane.vault_keys WHERE scope = ${p.id} ORDER BY version DESC`;
    const events = await db`SELECT at, actor, action, detail FROM control_plane.vault_audit WHERE project_id = ${p.id} ORDER BY at DESC LIMIT 50`;
    return reply.send({ keys, audit: events });
  });

  server.post('/api/projects/:id/vault/rotate', { ...auth, schema: { ...tags, summary: 'Rotate the project data key (re-encrypts its secrets)' } }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!p) return;
    const r = await rotateProjectKey(p.id, userId(request), request.ip);
    await redis.publish('odb:project-changed', p.id).catch(() => {});
    await audit(request, 'vault.project_key_rotated', { type: 'project', id: p.id, projectId: p.id }, r);
    return reply.send(r);
  });

  server.get('/api/admin/vault', { ...auth, schema: { ...tags, summary: 'Vault status (platform admins)' } }, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    return reply.send(await vaultStatus());
  });

  server.post('/api/admin/vault/rotate-master-key', { ...auth, schema: { ...tags, summary: 'Re-wrap every data key with the active master key' } }, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    const r = await rotateMasterKey(userId(request), request.ip);
    await audit(request, 'vault.master_key_rotated', { type: 'platform' }, r);
    return reply.send(r);
  });

  server.get('/api/admin/vault/audit', { ...auth, schema: { ...tags, summary: 'Vault audit log (platform admins)' } }, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    const q = request.query as { project_id?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
    const pid = q.project_id && /^[0-9a-f-]{36}$/i.test(q.project_id) ? q.project_id : null;
    const rows = await db`
      SELECT id, at, actor, project_id, action, detail, ip FROM control_plane.vault_audit
      WHERE (${pid}::uuid IS NULL OR project_id = ${pid}::uuid) ORDER BY at DESC LIMIT ${limit}`;
    return reply.send({ data: rows });
  });
};
