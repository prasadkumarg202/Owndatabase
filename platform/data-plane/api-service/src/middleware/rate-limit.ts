import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../lib/schema-cache.js';
import { config } from '../config.js';

/** Fixed one-minute window per API key (+ user). Fails open if Redis is down. */
export async function rateLimitMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.auth;
  if (!auth) return;
  const limit = auth.role === 'service_role' ? config.RATE_LIMIT_SERVICE
    : auth.role === 'authenticated' ? config.RATE_LIMIT_AUTHENTICATED : config.RATE_LIMIT_ANON;
  const who = auth.userId ? `u:${auth.userId}` : `k:${auth.key.id}:${req.ip}`;
  const key = `api-rl:${auth.project.id}:${who}:${Math.floor(Date.now() / 60000)}`;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 61);
    reply.header('X-RateLimit-Limit', limit);
    reply.header('X-RateLimit-Remaining', Math.max(0, limit - n));
    if (n > limit) return reply.status(429).header('Retry-After', 60).send({ error: 'Too Many Requests', message: `Rate limit of ${limit} requests/minute exceeded` });
    const day = new Date().toISOString().slice(0, 10);
    void redis.hincrby(`odb:usage:${auth.project.id}:${day}`, 'rest_requests', 1).catch(() => {});
  } catch (err) {
    req.log.warn({ err }, 'Rate limit check failed, allowing request');
  }
}
