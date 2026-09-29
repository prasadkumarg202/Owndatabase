/**
 * Personal access tokens for the CLI and CI (e.g. GitHub Actions: ODB_TOKEN).
 *
 *   GET    /api/auth/tokens        — your tokens (never the token itself)
 *   POST   /api/auth/tokens        — { name, expires_in_days? } → token shown once
 *   DELETE /api/auth/tokens/:id    — revoke
 *
 * A token acts as its user (same organizations and roles). Creating one needs
 * a signed-in session, so a leaked token cannot mint further tokens.
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit, userId } from '../lib/access.js';

const PREFIX = 'odb_pat_';
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const tags = { tags: ['auth'], security: [{ bearerAuth: [] }] };

/** Resolves a raw token to the request.user shape of a platform session, or null. */
export async function authenticatePat(raw: string): Promise<Record<string, unknown> | null> {
  if (!raw.startsWith(PREFIX) || raw.length > 200) return null;
  const [row] = await db`
    UPDATE control_plane.personal_access_tokens t SET last_used_at = NOW()
    FROM control_plane.platform_users u
    WHERE t.token_hash = ${sha256(raw)} AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > NOW())
      AND u.id = t.user_id AND u.is_active
    RETURNING t.id, t.user_id, u.email`;
  if (!row) return null;
  return { sub: row['user_id'], email: row['email'], role: 'platform_user', pat: row['id'] };
}

export const tokenRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate], schema: tags };

  server.get('/', auth, async (request, reply) => {
    const rows = await db`
      SELECT id, name, token_prefix, expires_at, last_used_at, revoked_at, created_at
      FROM control_plane.personal_access_tokens WHERE user_id = ${userId(request)} ORDER BY created_at DESC`;
    return reply.send({ data: rows });
  });

  server.post('/', auth, async (request, reply) => {
    if ((request.user as { pat?: string }).pat) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Sign in to create access tokens; a token cannot create tokens' });
    }
    const input = z.object({
      name: z.string().min(1).max(100).trim(),
      expires_in_days: z.number().int().min(1).max(365).nullable().default(90),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const token = PREFIX + randomBytes(32).toString('base64url');
    const [row] = await db`
      INSERT INTO control_plane.personal_access_tokens (user_id, name, token_hash, token_prefix, expires_at)
      VALUES (${userId(request)}, ${input.data.name}, ${sha256(token)}, ${token.slice(0, 16)},
              ${input.data.expires_in_days === null ? null : new Date(Date.now() + input.data.expires_in_days * 86400_000)})
      RETURNING id, name, token_prefix, expires_at, created_at`;
    await audit(request, 'access_token.created', { type: 'access_token', id: row!['id'] as string }, { name: input.data.name });
    return reply.status(201).send({ ...row, token, warning: 'Store this token securely. It will not be shown again.' });
  });

  server.delete('/:id', auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'Token not found' });
    const [row] = await db`
      UPDATE control_plane.personal_access_tokens SET revoked_at = NOW()
      WHERE id = ${id} AND user_id = ${userId(request)} AND revoked_at IS NULL RETURNING id`;
    if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Token not found' });
    await audit(request, 'access_token.revoked', { type: 'access_token', id });
    return reply.send({ success: true });
  });
};
