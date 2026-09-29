/**
 * Custom domains for a project's APIs.
 *
 *   GET    /api/projects/:id/domains
 *   POST   /api/projects/:id/domains                          { hostname }  → DNS records to create
 *   POST   /api/projects/:id/domains/:domainId/verify         checks the TXT record now
 *   POST   /api/projects/:id/domains/:domainId/force-verify   platform admins (support / tests)
 *   DELETE /api/projects/:id/domains/:domainId
 *   GET    /api/internal/domains/check?domain=<host>          200 for verified hosts — Caddy's on-demand TLS `ask`
 *
 * Verified hostnames are routed by every data-plane service (platform/shared/domains.ts)
 * and get certificates from Caddy on first use (on_demand TLS, only for hosts this approves).
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { ADMIN_ROLES, audit, requirePlatformAdmin, requireProject, userId } from '../lib/access.js';

const s = (summary: string) => ({ schema: { tags: ['projects'], summary, security: [{ bearerAuth: [] }] } });
const MAX_DOMAINS = 5;
const hostnameSchema = z.string().trim().toLowerCase().max(253)
  .regex(/^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/, 'Enter a hostname such as api.example.com');

function platformHost() {
  try { return new URL(config.publicUrl).hostname; } catch { return 'localhost'; }
}

function dnsRecords(d: Record<string, any>) {
  return [
    { type: 'TXT', name: `_odb-challenge.${d['hostname']}`, value: d['verification_token'], purpose: 'proves you control the domain' },
    { type: 'CNAME', name: d['hostname'], value: platformHost(), purpose: 'sends traffic to this platform (or an A record to its IP)' },
  ];
}

function view(d: Record<string, any>) {
  const base = `https://${d['hostname']}`;
  return {
    id: d['id'], hostname: d['hostname'], status: d['status'], verified_at: d['verified_at'], last_checked_at: d['last_checked_at'],
    last_error: d['last_error'], created_at: d['created_at'], dns_records: dnsRecords(d),
    endpoints: {
      rest_url: `${base}/rest/v1`, auth_url: `${base}/auth/v1`, storage_url: `${base}/storage/v1`,
      functions_url: `${base}/functions/v1`, realtime_url: `wss://${d['hostname']}/realtime`,
    },
  };
}

const changed = () => redis.publish('odb:domains-changed', '1').catch(() => {});

export const domainRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const uuid = /^[0-9a-f-]{36}$/i;

  server.get('/:id/domains', { ...auth, ...s('Custom domains') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id);
    if (!p) return;
    const rows = await db`SELECT * FROM control_plane.custom_domains WHERE project_id = ${p.id} ORDER BY created_at`;
    return reply.send({ data: rows.map(view) });
  });

  server.post('/:id/domains', { ...auth, ...s('Add a custom domain') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!p) return;
    const input = z.object({ hostname: hostnameSchema }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid hostname' });
    const host = input.data.hostname;
    if (host === platformHost() || host.endsWith(`.${platformHost()}`) || host === 'localhost') {
      return reply.status(400).send({ error: 'Validation Error', message: 'Use your own domain, not the platform hostname' });
    }
    const [{ n }] = await db`SELECT count(*)::int AS n FROM control_plane.custom_domains WHERE project_id = ${p.id}` as any;
    if (n >= MAX_DOMAINS) return reply.status(409).send({ error: 'Conflict', message: `A project can have at most ${MAX_DOMAINS} custom domains` });
    const [taken] = await db`SELECT 1 FROM control_plane.custom_domains WHERE lower(hostname) = ${host}`;
    if (taken) return reply.status(409).send({ error: 'Conflict', message: 'This domain is already added to a project' });
    const [row] = await db`
      INSERT INTO control_plane.custom_domains (project_id, hostname, verification_token, created_by)
      VALUES (${p.id}, ${host}, ${'odb-verify-' + randomBytes(16).toString('hex')}, ${userId(request)}) RETURNING *`;
    await audit(request, 'domain.added', { type: 'custom_domain', id: row!['id'] as string, projectId: p.id }, { hostname: host });
    return reply.status(201).send(view(row!));
  });

  server.post('/:id/domains/:domainId/verify', { ...auth, ...s('Check the DNS TXT record') }, async (request, reply) => {
    const { id, domainId } = request.params as { id: string; domainId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!uuid.test(domainId)) return reply.status(404).send({ error: 'Not Found', message: 'Domain not found' });
    const [d] = await db`SELECT * FROM control_plane.custom_domains WHERE id = ${domainId} AND project_id = ${p.id}`;
    if (!d) return reply.status(404).send({ error: 'Not Found', message: 'Domain not found' });
    let found = false;
    let error: string | null = null;
    try {
      const records = await dns.resolveTxt(`_odb-challenge.${d['hostname']}`);
      found = records.some((chunks) => chunks.join('') === d['verification_token']);
      if (!found) error = 'The TXT record exists but does not contain the verification token';
    } catch (err) {
      error = (err as { code?: string }).code === 'ENOTFOUND' || (err as { code?: string }).code === 'ENODATA'
        ? `No TXT record at _odb-challenge.${d['hostname']} yet (DNS changes can take a while)` : `DNS lookup failed: ${(err as Error).message}`;
    }
    const [row] = await db`
      UPDATE control_plane.custom_domains SET
        status = ${found ? 'verified' : d['status'] === 'verified' ? 'verified' : 'pending'},
        verified_at = ${found ? new Date() : d['verified_at']}, last_checked_at = NOW(), last_error = ${found ? null : error}
      WHERE id = ${domainId} RETURNING *`;
    if (found) {
      await changed();
      await audit(request, 'domain.verified', { type: 'custom_domain', id: domainId, projectId: p.id }, { hostname: d['hostname'] });
    }
    return reply.send(view(row!));
  });

  server.post('/:id/domains/:domainId/force-verify', { ...auth, ...s('Mark verified without DNS (platform admins)') }, async (request, reply) => {
    const { id, domainId } = request.params as { id: string; domainId: string };
    if (!(await requirePlatformAdmin(request, reply))) return;
    if (!uuid.test(domainId)) return reply.status(404).send({ error: 'Not Found', message: 'Domain not found' });
    const [row] = await db`
      UPDATE control_plane.custom_domains SET status = 'verified', verified_at = NOW(), last_checked_at = NOW(), last_error = NULL
      WHERE id = ${domainId} AND project_id = ${id} RETURNING *`;
    if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Domain not found' });
    await changed();
    await audit(request, 'domain.force_verified', { type: 'custom_domain', id: domainId, projectId: id }, { hostname: row['hostname'] });
    return reply.send(view(row));
  });

  server.delete('/:id/domains/:domainId', { ...auth, ...s('Remove a custom domain') }, async (request, reply) => {
    const { id, domainId } = request.params as { id: string; domainId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!uuid.test(domainId)) return reply.status(404).send({ error: 'Not Found', message: 'Domain not found' });
    const [row] = await db`DELETE FROM control_plane.custom_domains WHERE id = ${domainId} AND project_id = ${p.id} RETURNING hostname`;
    if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Domain not found' });
    await changed();
    await audit(request, 'domain.removed', { type: 'custom_domain', id: domainId, projectId: p.id }, { hostname: row['hostname'] });
    return reply.send({ success: true });
  });
};

/** Mounted at /api/internal — no auth: it only says whether a hostname is a verified custom domain. */
export const domainCheckRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get('/domains/check', async (request, reply) => {
    const { domain } = request.query as { domain?: string };
    if (!domain) return reply.status(400).send({ error: 'domain is required' });
    const [row] = await db`SELECT 1 FROM control_plane.custom_domains WHERE lower(hostname) = ${domain.toLowerCase()} AND status = 'verified'`;
    return row ? reply.send({ ok: true }) : reply.status(404).send({ ok: false });
  });
};
