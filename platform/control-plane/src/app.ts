/**
 * Fastify Application — builds and configures the server.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { metricsPlugin } from './plugins/metrics.js';

import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { organizationRoutes } from './routes/organizations.js';
import { invitationRoutes, orgInvitationRoutes } from './routes/invitations.js';
import { dbWebhookRoutes } from './routes/db-webhooks.js';
import { limitRoutes } from './routes/limits.js';
import { migrationRoutes } from './routes/migrations.js';
import { pgQueueRoutes } from './routes/pg-queues.js';
import { tokenRoutes, authenticatePat } from './routes/tokens.js';
import { projectRoutes } from './routes/projects.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { secretRoutes } from './routes/secrets.js';
import { backupRoutes } from './routes/backups.js';
import { databaseRoutes } from './routes/database.js';
import { functionRoutes } from './routes/functions.js';
import { projectUserRoutes } from './routes/project-users.js';
import { observabilityRoutes } from './routes/observability.js';

export async function buildApp() {
  const server = Fastify({
    logger: logger as any,
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    bodyLimit: 2 * 1024 * 1024,
  });

  await server.register(helmet, { contentSecurityPolicy: false });
  await server.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
  });

  await server.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'cp-rl:',
    keyGenerator: (request) => (request.headers['authorization'] as string | undefined)?.slice(-24) ?? request.ip,
    allowList: (request) => request.url.startsWith('/health') || request.url === '/metrics',
  });

  await server.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtExpiresIn } });

  await server.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'OwnDatabase Control API', version: '0.2.0', description: 'Manage organizations, projects, databases, auth, storage, backups, functions and queues.' },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    },
  });
  await server.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { docExpansion: 'list', deepLinking: true } });

  await server.register(metricsPlugin);

  server.decorate('authenticate', async function (request: any, reply: any) {
    // Personal access tokens (CLI / CI): odb_pat_…
    const bearer = String(request.headers['authorization'] ?? '');
    if (bearer.startsWith('Bearer odb_pat_')) {
      const user = await authenticatePat(bearer.slice(7));
      if (!user) return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid, expired or revoked access token' });
      request.user = user;
      return;
    }
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing authentication token' });
    }
    const user = request.user as { role?: string; sid?: string };
    if (user.role !== 'platform_user') {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Not a platform token' });
    }
    if (user.sid && (await redis.exists(`cp:revoked:${user.sid}`))) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Session has been revoked' });
    }
  });

  await server.register(healthRoutes, { prefix: '/health' });
  await server.register(healthRoutes, { prefix: '/api/health' });
  await server.register(authRoutes, { prefix: '/api/auth' });
  await server.register(organizationRoutes, { prefix: '/api/organizations' });
  await server.register(orgInvitationRoutes, { prefix: '/api/organizations' });
  await server.register(invitationRoutes, { prefix: '/api/invitations' });
  await server.register(projectRoutes, { prefix: '/api/projects' });
  await server.register(databaseRoutes, { prefix: '/api/projects' });
  await server.register(functionRoutes, { prefix: '/api/projects' });
  await server.register(projectUserRoutes, { prefix: '/api/projects' });
  await server.register(dbWebhookRoutes, { prefix: '/api/projects' });
  await server.register(limitRoutes, { prefix: '/api/projects' });
  await server.register(migrationRoutes, { prefix: '/api/projects' });
  await server.register(pgQueueRoutes, { prefix: '/api/projects' });
  await server.register(tokenRoutes, { prefix: '/api/auth/tokens' });
  await server.register(observabilityRoutes, { prefix: '/api' });
  await server.register(apiKeyRoutes, { prefix: '/api/keys' });
  await server.register(secretRoutes, { prefix: '/api/secrets' });
  await server.register(backupRoutes, { prefix: '/api/backups' });

  server.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: 'Not Found', message: `Route ${request.method} ${request.url} not found` });
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'Internal server error');
    void reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : (error.name ?? 'Error'),
      message: statusCode >= 500 ? 'Internal server error' : error.message,
      statusCode,
    });
  });

  return server;
}
