import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, PlatformAuth, type RequestAuth } from '../lib/platform-auth.js';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { redisSub } from '../lib/schema-cache.js';

export const platform = new PlatformAuth(db, config.JWT_SECRET, redisSub);

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth;
  }
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const { projectId } = req.params as { projectId?: string };
  if (!projectId) return reply.status(400).send({ error: 'Bad Request', message: 'Missing project id' });
  try {
    // dashboard users (owner / admin / developer of the project's organization) act as service_role, as in storage
    req.auth = await platform.authenticate(projectId, req.headers as any, req.query as any, { ip: req.ip, allowPlatformUser: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return reply.status(err.statusCode).send({ error: err.statusCode === 401 ? 'Unauthorized' : 'Error', message: err.message });
    }
    throw err;
  }
}
