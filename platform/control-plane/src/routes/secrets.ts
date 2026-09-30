/**
 * Secrets Routes
 *
 * GET    /api/secrets?project_id=...  — List secret names (never values)
 * POST   /api/secrets                 — Create/update a secret
 * DELETE /api/secrets/:id             — Delete a secret
 *
 * IMPORTANT:
 * - Secret values are NEVER returned after creation
 * - Values are sealed by the vault (envelope encryption, docs/vault.md)
 * - Only secret metadata (name, created_at) is shown
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { sealBytes } from '../lib/vault.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { requireProject, userId, audit, WRITE_ROLES } from '../lib/access.js';

const createSecretSchema = z.object({
  project_id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Secret names must be UPPER_SNAKE_CASE'),
  value: z.string().min(1).max(65536),
  environment_id: z.string().uuid().optional(),
});

export const secretRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const tags = { tags: ['secrets'], security: [{ bearerAuth: [] }] };

  server.get('/', { ...auth, schema: { ...tags, summary: 'List secret names for a project (values never returned)' } }, async (request, reply) => {
    const { project_id } = request.query as { project_id?: string };
    const p = await requireProject(request, reply, project_id ?? '');
    if (!p) return;
    const secrets = await db`
      SELECT id, name, version, is_active, created_at, updated_at
      FROM control_plane.secrets WHERE project_id = ${p.id} AND is_active = true ORDER BY name ASC`;
    return reply.send({ data: secrets });
  });

  server.post('/', { ...auth, schema: { ...tags, summary: 'Create or update a secret' } }, async (request, reply) => {
    const input = createSecretSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const { project_id, name, value, environment_id } = input.data;
    const p = await requireProject(request, reply, project_id, WRITE_ROLES);
    if (!p) return;

    const encryptedValue = await sealBytes(project_id, `function_secret:${name}`, value);
    const secret = await db.begin(async (sql) => {
      await sql`UPDATE control_plane.secrets SET is_active = false WHERE project_id = ${project_id} AND name = ${name} AND is_active = true`;
      const [{ max_version }] = await sql`
        SELECT COALESCE(MAX(version), 0)::int AS max_version FROM control_plane.secrets
        WHERE project_id = ${project_id} AND name = ${name}` as any;
      const [row] = await sql`
        INSERT INTO control_plane.secrets (project_id, environment_id, name, value_encrypted, version, created_by)
        VALUES (${project_id}, ${environment_id ?? null}, ${name}, ${encryptedValue}, ${max_version + 1}, ${userId(request)})
        RETURNING id, name, version, created_at`;
      return row!;
    });
    await redis.publish('odb:project-changed', project_id).catch(() => {});  // services drop cached secrets
    await audit(request, 'secret.created', { type: 'secret', id: secret['id'] as string, projectId: project_id }, { name, version: secret['version'] });
    logger.info({ projectId: project_id, secretName: name }, 'Secret created/updated');
    return reply.status(201).send({ ...secret, message: 'Secret stored. The value cannot be retrieved again.' });
  });

  server.delete('/:id', { ...auth, schema: { ...tags, summary: 'Delete a secret' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'Secret not found' });
    const [secret] = await db`SELECT id, name, project_id FROM control_plane.secrets WHERE id = ${id} AND is_active`;
    if (!secret) return reply.status(404).send({ error: 'Not Found', message: 'Secret not found' });
    const p = await requireProject(request, reply, secret['project_id'] as string, ['owner', 'admin']);
    if (!p) return;
    await db`UPDATE control_plane.secrets SET is_active = false WHERE project_id = ${p.id} AND name = ${secret['name'] as string}`;
    await redis.publish('odb:project-changed', p.id).catch(() => {});
    await audit(request, 'secret.deleted', { type: 'secret', id, projectId: p.id }, { name: secret['name'] });
    return reply.send({ success: true });
  });
};
