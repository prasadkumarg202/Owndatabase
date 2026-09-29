/**
 * API Key Routes
 *
 * GET    /api/keys?project_id=...     — List API keys for a project (never the key itself)
 * POST   /api/keys                    — Create a key (full key returned once)
 * DELETE /api/keys/:id                — Revoke a key
 * POST   /api/keys/:id/rotate         — Replace a key; the old one keeps working for a grace period
 * POST   /api/keys/rotate             — Rotate every active key of a project (e.g. after a leak)
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { audit, requireProject, WRITE_ROLES } from '../lib/access.js';
import { generateApiKey } from '../lib/provision.js';

const createKeySchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(255).trim(),
  type: z.enum(['anon', 'authenticated', 'service_role', 'admin']),
  expires_at: z.string().datetime({ offset: true }).optional(),
});

export const apiKeyRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const tags = { tags: ['api-keys'], security: [{ bearerAuth: [] }] };

  server.get('/', { ...auth, schema: { ...tags, summary: 'List API keys for a project' } }, async (request, reply) => {
    const { project_id } = request.query as { project_id?: string };
    const p = await requireProject(request, reply, project_id ?? '');
    if (!p) return;
    const keys = await db`
      SELECT id, name, key_prefix, type, is_active, expires_at, last_used_at, created_at, rotated_from, rotated_at,
             (is_active AND (expires_at IS NULL OR expires_at > NOW())) AS usable
      FROM control_plane.api_keys WHERE project_id = ${p.id}
      ORDER BY is_active DESC, created_at DESC`;
    return reply.send({ data: keys });
  });

  server.post('/', { ...auth, schema: { ...tags, summary: 'Create a new API key' } }, async (request, reply) => {
    const input = createKeySchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const { project_id, name, type, expires_at } = input.data;

    const p = await requireProject(request, reply, project_id, WRITE_ROLES);
    if (!p) return;
    if (['service_role', 'admin'].includes(type) && !['owner', 'admin'].includes(p.role)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only owners and admins can create service_role or admin keys' });
    }

    const { key, hash, prefix } = generateApiKey(type);
    const [created] = await db`
      INSERT INTO control_plane.api_keys (project_id, name, key_hash, key_prefix, type, expires_at, created_by)
      VALUES (${project_id}, ${name}, ${hash}, ${prefix}, ${type}, ${expires_at ?? null}, ${(request.user as any).sub})
      RETURNING id, name, key_prefix, type, is_active, expires_at, created_at`;
    await audit(request, 'api_key.created', { type: 'api_key', id: created!['id'] as string, projectId: project_id }, { name, type });
    return reply.status(201).send({ ...created, key, warning: 'Store this key securely. It will not be shown again.' });
  });

  const graceSchema = z.number().int().min(0).max(7 * 86400).default(3600);

  /**
   * Creates the replacement and shortens the old key's life to `grace` seconds
   * (0 = revoke now). Runs in the caller's transaction.
   */
  async function rotateOne(sql: any, old: Record<string, any>, grace: number, uid: string) {
    const { key, hash, prefix } = generateApiKey(old['type'] as any);
    const [created] = await sql`
      INSERT INTO control_plane.api_keys (project_id, name, key_hash, key_prefix, type, created_by, rotated_from, metadata)
      VALUES (${old['project_id']}, ${old['name']}, ${hash}, ${prefix}, ${old['type']}, ${uid}, ${old['id']}, ${sql.json(old['metadata'] ?? {})})
      RETURNING id, name, key_prefix, type, is_active, expires_at, created_at, rotated_from`;
    const [prev] = await sql`
      UPDATE control_plane.api_keys SET
        rotated_at = NOW(), updated_at = NOW(),
        is_active = ${grace > 0},
        expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < NOW() + make_interval(secs => ${grace})
                          THEN expires_at ELSE NOW() + make_interval(secs => ${grace}) END
      WHERE id = ${old['id']} RETURNING expires_at`;
    return { ...created, key, previous_key: { id: old['id'], key_prefix: old['key_prefix'], expires_at: grace > 0 ? prev['expires_at'] : null, revoked: grace === 0 } };
  }

  const rotationForbidden = (role: string, type: string) => ['service_role', 'admin'].includes(type) && !['owner', 'admin'].includes(role);

  server.post('/:id/rotate', { ...auth, schema: { ...tags, summary: 'Rotate an API key (old key valid for a grace period)' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'API key not found' });
    const input = z.object({ grace_period_seconds: graceSchema }).safeParse(request.body ?? {});
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'grace_period_seconds must be 0..604800' });
    const [old] = await db`SELECT * FROM control_plane.api_keys WHERE id = ${id}`;
    if (!old) return reply.status(404).send({ error: 'Not Found', message: 'API key not found' });
    const p = await requireProject(request, reply, old['project_id'] as string, WRITE_ROLES);
    if (!p) return;
    if (rotationForbidden(p.role, old['type'] as string)) return reply.status(403).send({ error: 'Forbidden', message: 'Only owners and admins can rotate service_role or admin keys' });
    if (!old['is_active'] || (old['expires_at'] && new Date(old['expires_at'] as string) <= new Date())) {
      return reply.status(409).send({ error: 'Conflict', message: 'This key is revoked or expired; create a new key instead' });
    }
    if (old['rotated_at']) return reply.status(409).send({ error: 'Conflict', message: 'This key has already been rotated' });

    const grace = input.data.grace_period_seconds;
    const out = await db.begin((sql) => rotateOne(sql, old, grace, (request.user as any).sub));
    // drop cached lookups so the new expiry (or revocation) applies at once
    await redis.publish('odb:apikey-revoked', old['key_hash'] as string).catch(() => {});
    await audit(request, 'api_key.rotated', { type: 'api_key', id, projectId: p.id }, { new_key_id: out['id'], grace_period_seconds: grace });
    return reply.status(201).send({ ...out, warning: 'Store this key securely. It will not be shown again.' });
  });

  server.post('/rotate', { ...auth, schema: { ...tags, summary: 'Rotate all active keys of a project' } }, async (request, reply) => {
    const input = z.object({
      project_id: z.string().uuid(),
      types: z.array(z.enum(['anon', 'authenticated', 'service_role', 'admin'])).min(1).optional(),
      grace_period_seconds: graceSchema,
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const p = await requireProject(request, reply, input.data.project_id, ['owner', 'admin']);
    if (!p) return;
    const keys = await db`
      SELECT * FROM control_plane.api_keys
      WHERE project_id = ${p.id} AND is_active AND rotated_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        ${input.data.types ? db`AND type::text = ANY(${input.data.types})` : db``}
      ORDER BY created_at`;
    const grace = input.data.grace_period_seconds;
    const uid = (request.user as any).sub;
    const rotated = await db.begin(async (sql) => {
      const out = [];
      for (const k of keys) out.push(await rotateOne(sql, k, grace, uid));
      return out;
    });
    for (const k of keys) await redis.publish('odb:apikey-revoked', k['key_hash'] as string).catch(() => {});
    await audit(request, 'api_key.rotated_all', { type: 'project', id: p.id, projectId: p.id }, { count: rotated.length, grace_period_seconds: grace });
    return reply.status(201).send({ data: rotated, warning: 'Store these keys securely. They will not be shown again.' });
  });

  server.delete('/:id', { ...auth, schema: { ...tags, summary: 'Revoke an API key' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'API key not found' });
    const [key] = await db`SELECT id, project_id, key_hash FROM control_plane.api_keys WHERE id = ${id}`;
    if (!key) return reply.status(404).send({ error: 'Not Found', message: 'API key not found' });
    const p = await requireProject(request, reply, key['project_id'] as string, WRITE_ROLES);
    if (!p) return;

    await db`UPDATE control_plane.api_keys SET is_active = false WHERE id = ${id}`;
    // Data-plane services cache key lookups briefly; tell them to drop it now.
    await redis.publish('odb:apikey-revoked', key['key_hash'] as string).catch(() => {});
    await audit(request, 'api_key.revoked', { type: 'api_key', id, projectId: p.id });
    return reply.send({ success: true, message: 'API key revoked' });
  });
};
