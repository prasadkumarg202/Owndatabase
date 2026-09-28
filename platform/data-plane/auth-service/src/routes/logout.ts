import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { userContext } from '../middleware/auth.js';
import { audit } from '../lib/session.js';

export default async function (server: FastifyInstance) {
  // ?scope=global (all devices) | local (default, this session) | others
  server.post('/v1/:projectId/logout', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId, claims } = req.ctx;
    const q = req.query as { scope?: string; all?: string };
    const scope = q.all === 'true' ? 'global' : (q.scope ?? 'local');
    const sessionId = claims?.['session_id'] as string;
    let rows;
    if (scope === 'global') rows = await db`DELETE FROM auth.sessions WHERE user_id = ${userId!} RETURNING id`;
    else if (scope === 'others') rows = await db`DELETE FROM auth.sessions WHERE user_id = ${userId!} AND id <> ${sessionId} RETURNING id`;
    else rows = await db`DELETE FROM auth.sessions WHERE id = ${sessionId} AND user_id = ${userId!} RETURNING id`;
    await audit(project.id, scope === 'global' ? 'logout_all' : 'logout', req, userId, null, { scope, sessions: rows.length });
    return reply.status(200).send({ message: 'Signed out', sessions_revoked: rows.length });
  });
}
