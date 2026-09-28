/**
 * Health check routes.
 *
 * GET /health            — Basic liveness check
 * GET /health/ready      — Readiness check (verifies DB + Redis)
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';

export const healthRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // Liveness — just responds 200 if the process is alive
  server.get(
    '/',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness check',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              service: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.send({
        status: 'ok',
        service: 'control-api',
        timestamp: new Date().toISOString(),
      });
    }
  );

  // Readiness — checks downstream dependencies
  server.get(
    '/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness check',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              checks: {
                type: 'object',
                additionalProperties: true,
              },
              timestamp: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              checks: {
                type: 'object',
                additionalProperties: true,
              },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
      let allHealthy = true;

      // Check PostgreSQL
      const pgStart = Date.now();
      try {
        await db`SELECT 1`;
        checks['postgresql'] = { status: 'healthy', latency: Date.now() - pgStart };
      } catch (err) {
        allHealthy = false;
        checks['postgresql'] = {
          status: 'unhealthy',
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }

      // Check Redis
      const redisStart = Date.now();
      try {
        await redis.ping();
        checks['redis'] = { status: 'healthy', latency: Date.now() - redisStart };
      } catch (err) {
        allHealthy = false;
        checks['redis'] = {
          status: 'unhealthy',
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }

      const statusCode = allHealthy ? 200 : 503;
      return reply.status(statusCode).send({
        status: allHealthy ? 'ready' : 'degraded',
        checks,
        timestamp: new Date().toISOString(),
      });
    }
  );
};
