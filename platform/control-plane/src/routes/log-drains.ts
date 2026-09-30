/**
 * Log drains (docs/log-drains.md)
 *
 *   GET    /api/projects/:id/log-drains
 *   POST   /api/projects/:id/log-drains                     { name, kind, url?, site?, secret?, sources? }
 *   PATCH  /api/projects/:id/log-drains/:drainId            { name?, enabled?, sources?, url?, site?, secret? }
 *   DELETE /api/projects/:id/log-drains/:drainId
 *   POST   /api/projects/:id/log-drains/:drainId/test       sends one test event now → { ok, error? }
 *
 * The queue worker delivers (workers/queue-worker/src/log-drains.ts). API keys and signing secrets are
 * sealed by the vault and never returned.
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { ADMIN_ROLES, audit, requireProject, userId } from '../lib/access.js';
import { open, seal } from '../lib/vault.js';
import { DRAIN_SOURCES, drainUrl, sendToDrain } from '../lib/log-drain.js';

const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com'];
const ALLOW_PRIVATE = process.env['WEBHOOK_ALLOW_PRIVATE'] === 'true';   // development only
const MAX_DRAINS = 5;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
}

async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && !(ALLOW_PRIVATE && u.protocol === 'http:')) throw new Error('Log drain URLs must be https');
  if (ALLOW_PRIVATE) return;
  const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('Log drains to private / internal addresses are blocked');
}

const view = (d: Record<string, any>) => ({
  id: d['id'], name: d['name'], kind: d['kind'], url: d['url'], site: d['config']?.['site'] ?? null, sources: d['sources'],
  enabled: d['enabled'], has_secret: !!d['secret_sealed'], endpoint: (() => { try { return drainUrl(d as any); } catch { return null; } })(),
  last_delivered_at: d['last_delivered_at'], last_error: d['last_error'], consecutive_failures: d['consecutive_failures'],
  created_at: d['created_at'],
});

const baseSchema = {
  name: z.string().max(100),
  url: z.string().url().max(1000).nullable(),
  site: z.enum(DATADOG_SITES as [string, ...string[]]),
  secret: z.string().min(1).max(500),
  sources: z.array(z.enum(DRAIN_SOURCES)).min(1),
};
const createSchema = z.object({ kind: z.enum(['webhook', 'datadog', 'logtail']), ...baseSchema }).partial({ name: true, url: true, site: true, secret: true, sources: true });
const patchSchema = z.object({ ...baseSchema, enabled: z.boolean() }).partial();

export const logDrainRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (summary: string) => ({ schema: { tags: ['logs'], summary, security: [{ bearerAuth: [] }] } });
  const bad = (reply: any, message: string, status = 400) => reply.status(status).send({ error: 'Validation Error', message });

  async function load(projectId: string, drainId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(drainId)) return null;
    const [d] = await db`SELECT * FROM control_plane.log_drains WHERE id = ${drainId} AND project_id = ${projectId}`;
    return d ?? null;
  }

  server.get('/:id/log-drains', { ...auth, ...s('List log drains') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!p) return;
    const rows = await db`SELECT * FROM control_plane.log_drains WHERE project_id = ${p.id} ORDER BY created_at`;
    return reply.send({ data: rows.map(view) });
  });

  server.post('/:id/log-drains', { ...auth, ...s('Add a log drain') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!p) return;
    const b = createSchema.safeParse(request.body);
    if (!b.success) return bad(reply, b.error.errors[0]?.message ?? 'Invalid input');
    const d = b.data;
    if (d.kind === 'webhook' && !d.url) return bad(reply, 'A webhook drain needs a url');
    if (d.kind !== 'webhook' && !d.secret) return bad(reply, d.kind === 'datadog' ? 'A Datadog drain needs the API key (secret)' : 'A Better Stack drain needs the source token (secret)');
    if (d.url) { try { await assertPublicUrl(d.url); } catch (err) { return bad(reply, (err as Error).message); } }
    const [{ n }] = await db`SELECT count(*)::int AS n FROM control_plane.log_drains WHERE project_id = ${p.id}` as any;
    if (n >= MAX_DRAINS) return bad(reply, `A project can have at most ${MAX_DRAINS} log drains`, 409);
    const id = randomUUID();
    // start from now: a new drain does not replay history
    const nowIso = new Date().toISOString();
    const cursor = { audit: nowIso, auth: nowIso, functions: nowIso, platform: String(BigInt(Date.now()) * 1_000_000n) };
    const [row] = await db`
      INSERT INTO control_plane.log_drains (id, project_id, name, kind, url, config, secret_sealed, sources, cursor, created_by)
      VALUES (${id}, ${p.id}, ${d.name ?? ''}, ${d.kind}, ${d.url ?? null}, ${db.json(d.kind === 'datadog' ? { site: d.site ?? 'datadoghq.com' } : {})},
              ${d.secret ? await seal(p.id, `log_drain:${id}`, d.secret) : null}, ${d.sources ?? [...DRAIN_SOURCES]}, ${db.json(cursor)}, ${userId(request)})
      RETURNING *`;
    await audit(request, 'log_drain.created', { type: 'log_drain', id, projectId: p.id }, { kind: d.kind });
    return reply.status(201).send(view(row!));
  });

  server.patch('/:id/log-drains/:drainId', { ...auth, ...s('Update a log drain') }, async (request, reply) => {
    const { id, drainId } = request.params as { id: string; drainId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const cur = await load(p.id, drainId);
    if (!cur) return reply.status(404).send({ error: 'Not Found', message: 'Log drain not found' });
    const b = patchSchema.safeParse(request.body);
    if (!b.success) return bad(reply, b.error.errors[0]?.message ?? 'Invalid input');
    const d = b.data;
    if (d.url) { try { await assertPublicUrl(d.url); } catch (err) { return bad(reply, (err as Error).message); } }
    if (cur['kind'] === 'webhook' && d.url === null) return bad(reply, 'A webhook drain needs a url');
    const [row] = await db`
      UPDATE control_plane.log_drains SET
        name = ${d.name ?? cur['name']},
        url = ${d.url !== undefined ? d.url : cur['url']},
        config = ${db.json(cur['kind'] === 'datadog' && d.site ? { ...cur['config'], site: d.site } : cur['config'])},
        sources = ${d.sources ?? cur['sources']},
        secret_sealed = ${d.secret ? await seal(p.id, `log_drain:${drainId}`, d.secret) : cur['secret_sealed']},
        enabled = ${d.enabled ?? cur['enabled']},
        -- switching a drain back on starts over with a clean slate
        consecutive_failures = ${d.enabled ? 0 : cur['consecutive_failures']},
        next_attempt_at = ${d.enabled ? new Date() : cur['next_attempt_at']},
        last_error = ${d.enabled ? null : cur['last_error']}
      WHERE id = ${drainId} RETURNING *`;
    await audit(request, 'log_drain.updated', { type: 'log_drain', id: drainId, projectId: p.id }, { enabled: row!['enabled'] });
    return reply.send(view(row!));
  });

  server.delete('/:id/log-drains/:drainId', { ...auth, ...s('Delete a log drain') }, async (request, reply) => {
    const { id, drainId } = request.params as { id: string; drainId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!/^[0-9a-f-]{36}$/i.test(drainId)) return reply.status(404).send({ error: 'Not Found', message: 'Log drain not found' });
    const [row] = await db`DELETE FROM control_plane.log_drains WHERE id = ${drainId} AND project_id = ${p.id} RETURNING id`;
    if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Log drain not found' });
    await audit(request, 'log_drain.deleted', { type: 'log_drain', id: drainId, projectId: p.id });
    return reply.send({ success: true });
  });

  server.post('/:id/log-drains/:drainId/test', { ...auth, ...s('Send a test event to a log drain') }, async (request, reply) => {
    const { id, drainId } = request.params as { id: string; drainId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const d = await load(p.id, drainId);
    if (!d) return reply.status(404).send({ error: 'Not Found', message: 'Log drain not found' });
    try {
      const secret = d['secret_sealed'] ? await open(p.id, `log_drain:${drainId}`, d['secret_sealed']) : null;
      await sendToDrain({ id: drainId, project_id: p.id, kind: d['kind'], url: d['url'], config: d['config'] ?? {} }, [{
        timestamp: new Date().toISOString(), source: 'audit', event: 'log_drain.test', level: 'info',
        message: 'Test event from OwnDatabase: this log drain works.', project_id: p.id, metadata: { drain: d['name'] },
      }], secret, assertPublicUrl);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.send({ ok: false, error: (err as Error).message });
    }
  });
};
