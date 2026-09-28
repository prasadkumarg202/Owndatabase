/**
 * Request context for auth routes.
 *
 * `projectContext` requires a valid project API key (anon or service_role).
 * `userContext` additionally requires a valid user access token.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type RequestAuth } from '../lib/platform-auth.js';
import { platform } from '../lib/session.js';
import { db } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestAuth;
  }
}

async function resolve(req: FastifyRequest, reply: FastifyReply, needUser: boolean) {
  const { projectId } = req.params as { projectId: string };
  try {
    req.ctx = await platform.authenticate(projectId, req.headers as any, req.query as any);
  } catch (err) {
    if (err instanceof AuthError) return reply.status(err.statusCode).send({ error: 'Unauthorized', message: err.message });
    throw err;
  }
  if (needUser && !req.ctx.userId) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'A user access token is required (Authorization: Bearer <token>)' });
  }
  if (needUser) {
    // Access tokens are stateless, but user-facing auth endpoints also
    // require the session to still exist (logout / password reset revoke it).
    const [s] = await db`SELECT 1 FROM auth.sessions WHERE id = ${req.ctx.claims?.['session_id'] ?? null} AND (not_after IS NULL OR not_after > NOW())`;
    if (!s) return reply.status(401).send({ error: 'Unauthorized', message: 'Session has ended. Please sign in again.' });
  }
}

export async function projectContext(req: FastifyRequest, reply: FastifyReply) {
  return resolve(req, reply, false);
}

export async function userContext(req: FastifyRequest, reply: FastifyReply) {
  return resolve(req, reply, true);
}

export async function serviceContext(req: FastifyRequest, reply: FastifyReply) {
  await resolve(req, reply, false);
  if (reply.sent) return;
  if (req.ctx.role !== 'service_role') {
    return reply.status(403).send({ error: 'Forbidden', message: 'This endpoint requires a service_role API key' });
  }
}
