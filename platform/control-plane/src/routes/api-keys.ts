/**
 * API Key Routes
 *
 * GET    /api/keys?project_id=...     — List API keys for a project (never the key itself)
 * POST   /api/keys                    — Create a key (full key returned once)
 * DELETE /api/keys/:id                — Revoke a key
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
      SELECT id, name, key_prefix, type, is_active, expires_at, last_used_at, created_at
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
