import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../lib/schema-cache.js';
import { config } from '../config.js';
import { isDbReadOnly, limitOf, QUOTA_ERROR, secondsUntilUtcMidnight, utcDay } from '../lib/limits.js';

/**
 * Fixed one-minute window per API key (+ user), the project's daily request
 * quota, and read-only mode when the project is over its database size limit.
 * Fails open if Redis is down.
 */
export async function rateLimitMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.auth;
  if (!auth) return;

  // Over the database size limit: reads and deletes only, so the data can be trimmed
  // (GraphQL sends queries as POST too: it refuses mutations itself when read-only)
  if (isDbReadOnly(auth.project) && ['POST', 'PUT', 'PATCH'].includes(req.method) && !req.url.startsWith('/graphql/')) {
    return reply.status(402).send({
      error: QUOTA_ERROR,
      message: 'This project is over its database size limit and is read-only. Delete data or ask for a higher limit.',
    });
  }

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

    // Per-key cap across every client using the key (set per API key)
    const keyLimit = auth.key.rate_limit_per_minute;
    if (keyLimit) {
      const kk = `api-rl-key:${auth.key.id}:${Math.floor(Date.now() / 60000)}`;
      const kn = await redis.incr(kk);
      if (kn === 1) await redis.expire(kk, 61);
      reply.header('X-RateLimit-Key-Limit', keyLimit);
      reply.header('X-RateLimit-Key-Remaining', Math.max(0, keyLimit - kn));
      if (kn > keyLimit) {
        return reply.status(429).header('Retry-After', 60).send({ error: 'Too Many Requests', message: `This API key is limited to ${keyLimit} requests/minute` });
      }
    }

    const usageKey = `odb:usage:${auth.project.id}:${utcDay()}`;
    const daily = limitOf(auth.project, 'api_requests_per_day');
    if (daily === null) {
      void redis.hincrby(usageKey, 'rest_requests', 1).catch(() => {});
    } else {
      const used = await redis.hincrby(usageKey, 'rest_requests', 1);
      reply.header('X-Quota-Limit', daily);
      reply.header('X-Quota-Remaining', Math.max(0, daily - used));
      if (used > daily) {
        return reply.status(429).header('Retry-After', secondsUntilUtcMidnight()).send({
          error: QUOTA_ERROR, message: `This project has used its ${daily} API requests for today (resets at 00:00 UTC)`,
        });
      }
    }
  } catch (err) {
    req.log.warn({ err }, 'Rate limit check failed, allowing request');
  }
}
