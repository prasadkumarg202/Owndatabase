import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { projectContext } from '../middleware/auth.js';
import { audit, getUserById, issueSession, sha256 } from '../lib/session.js';

const schema = z.object({ refresh_token: z.string().min(10) });

/**
 * Refresh-token rotation with reuse detection: every refresh token works
 * once. Presenting an already-used token revokes the whole session, which
 * limits the damage of a stolen token.
 */
export async function refreshSession(req: FastifyRequest, reply: FastifyReply) {
  const { project } = req.ctx;
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: 'refresh_token is required' });

  const [rec] = await db`
    SELECT t.id, t.session_id, t.user_id, t.revoked, s.not_after, s.aal, u.project_id
    FROM auth.refresh_tokens t
    JOIN auth.sessions s ON s.id = t.session_id
    JOIN auth.users u ON u.id = t.user_id
    WHERE t.token = ${sha256(parsed.data.refresh_token)}`;

  if (!rec || rec['project_id'] !== project.id) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
  }
  if (rec['revoked']) {
    await db`DELETE FROM auth.sessions WHERE id = ${rec['session_id'] as string}`;
    await audit(project.id, 'refresh_token_reuse_detected', req, rec['user_id'] as string, null, {});
    return reply.status(401).send({ error: 'Unauthorized', message: 'Refresh token already used. Session revoked.' });
  }
  if (rec['not_after'] && new Date(rec['not_after'] as string) < new Date()) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Session expired' });
  }
  const user = await getUserById(project.id, rec['user_id'] as string);
  if (!user || (user.banned_until && new Date(user.banned_until) > new Date())) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'User is not allowed to sign in' });
  }

  await db`UPDATE auth.refresh_tokens SET revoked = true, updated_at = NOW() WHERE id = ${rec['id'] as number}`;
  const session = await issueSession(project, user, req, { sessionId: rec['session_id'] as string, aal: rec['aal'] as 'aal1' | 'aal2' });
  await audit(project.id, 'token_refreshed', req, user.id, rec['session_id'] as string);
  return reply.send(session);
}

export default async function (server: FastifyInstance) {
  server.post('/v1/:projectId/refresh', { preValidation: [projectContext] }, refreshSession);
}
