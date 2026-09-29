import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { collectDefaultMetrics, register, Counter } from 'prom-client';
import { config } from './config.js';
import { db } from './lib/db.js';
import { redis, redisSub } from './lib/redis.js';
import { projectContext } from './middleware/auth.js';
import { normalizePhone } from './lib/sms.js';

import signupRoutes from './routes/signup.js';
import loginRoutes from './routes/login.js';
import logoutRoutes from './routes/logout.js';
import refreshRoutes from './routes/refresh.js';
import verifyRoutes from './routes/verify.js';
import forgotPasswordRoutes from './routes/forgot-password.js';
import resetPasswordRoutes from './routes/reset-password.js';
import userRoutes from './routes/user.js';
import mfaRoutes from './routes/mfa.js';
import oauthRoutes from './routes/oauth.js';
import adminRoutes from './routes/admin.js';
import { initTracing, shutdownTracing, tracingPlugin } from './lib/tracing.js';
import { DomainMap } from './lib/domains.js';

collectDefaultMetrics({ prefix: 'owndatabase_auth_' });
const requests = new Counter({ name: 'owndatabase_auth_requests_total', help: 'Auth requests', labelNames: ['route', 'status'] });

initTracing('auth-service');
// custom domains: api.example.com/rest/v1/table → /v1/<project>/table (see lib/domains.ts)
const domains = new DomainMap(db, redisSub);
const server = Fastify({
  logger: { level: config.LOG_LEVEL, base: { service: 'auth-service' } },
  trustProxy: true,
  rewriteUrl: domains.rewrite,
});
tracingPlugin(server);

await server.register(helmet, { contentSecurityPolicy: false });
await server.register(cors, {
  origin: true, credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-api-key', 'x-client-info'],
});

server.addHook('onResponse', async (req, reply) => {
  requests.inc({ route: req.routeOptions?.url ?? 'unmatched', status: String(reply.statusCode) });
});

server.get('/health', async () => ({ status: 'ok', service: 'auth-service', timestamp: new Date().toISOString() }));
server.get('/health/ready', async (_req, reply) => {
  const checks: Record<string, string> = {};
  try { await db`SELECT 1`; checks['postgresql'] = 'healthy'; } catch { checks['postgresql'] = 'unhealthy'; }
  try { await redis.ping(); checks['redis'] = 'healthy'; } catch { checks['redis'] = 'unhealthy'; }
  const ok = Object.values(checks).every((v) => v === 'healthy');
  return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
});
server.get('/metrics', async (_req, reply) => reply.header('Content-Type', register.contentType).send(await register.metrics()));

// Development helper: read captured emails (never enable in production)
if (config.AUTH_DEV_MAILBOX) {
  server.log.warn('AUTH_DEV_MAILBOX is enabled — outgoing emails and SMS are readable over HTTP. Do not use in production.');
  server.get('/v1/:projectId/_dev/emails', { preValidation: [projectContext] }, async (req, reply) => {
    const { to } = req.query as { to?: string };
    if (!to) return reply.status(400).send({ error: 'to is required' });
    const raw = await redis.lrange(`auth:dev-mailbox:${req.ctx.project.id}:${to.toLowerCase()}`, 0, 19);
    return reply.send({ data: raw.map((r) => JSON.parse(r)) });
  });
  server.get('/v1/:projectId/_dev/sms', { preValidation: [projectContext] }, async (req, reply) => {
    const phone = normalizePhone((req.query as { phone?: string }).phone ?? '');
    if (!phone) return reply.status(400).send({ error: 'phone is required' });
    const raw = await redis.lrange(`auth:dev-sms:${req.ctx.project.id}:${phone}`, 0, 19);
    return reply.send({ data: raw.map((r) => JSON.parse(r)) });
  });
}

for (const r of [signupRoutes, loginRoutes, logoutRoutes, refreshRoutes, verifyRoutes, forgotPasswordRoutes,
  resetPasswordRoutes, userRoutes, mfaRoutes, oauthRoutes, adminRoutes]) {
  await server.register(r);
}

server.setNotFoundHandler((_req, reply) => { void reply.status(404).send({ error: 'Not Found' }); });
server.setErrorHandler((error, req, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) req.log.error({ err: error }, 'Unhandled error');
  void reply.status(status).send({ error: status >= 500 ? 'Internal Server Error' : error.name, message: status >= 500 ? 'Internal server error' : error.message });
});

try {
  await server.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  server.log.error(err, 'Failed to start auth service');
  process.exit(1);
}

const shutdown = async () => {
  await server.close();
  await db.end({ timeout: 5 });
  redis.disconnect();
  await shutdownTracing(); process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
