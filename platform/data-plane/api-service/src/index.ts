/**
 * OwnDatabase Data API — REST (Phase 3), RPC and Functions (Phase 8).
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { collectDefaultMetrics, register, Counter } from 'prom-client';
import { config } from './config.js';
import { db, poolerDb } from './lib/db.js';
import { replicaDb, replicaStatus } from './lib/replica.js';
import { redis, redisSub } from './lib/schema-cache.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { openApiHandler } from './lib/openapi.js';
import restRoutes from './routes/rest.js';
import rpcRoutes from './routes/rpc.js';
import functionRoutes from './routes/functions.js';
import graphqlRoutes from './routes/graphql.js';
import { initTracing, shutdownTracing, tracingPlugin } from './lib/tracing.js';
import { DomainMap } from './lib/domains.js';

collectDefaultMetrics({ prefix: 'owndatabase_api_' });
const requests = new Counter({ name: 'owndatabase_api_requests_total', help: 'Data API requests', labelNames: ['project_id', 'method', 'status'] });

initTracing('api-service');
// custom domains: api.example.com/rest/v1/table → /v1/<project>/table (see lib/domains.ts)
const domains = new DomainMap(db, redisSub);
const server = Fastify({
  logger: { level: config.LOG_LEVEL, base: { service: 'api-service' } },
  trustProxy: true,
  rewriteUrl: domains.rewrite,
  bodyLimit: 10 * 1024 * 1024,
});
tracingPlugin(server);

await server.register(helmet, { contentSecurityPolicy: false });
await server.register(cors, {
  origin: true, credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-api-key', 'Prefer', 'Range', 'Accept-Profile', 'Content-Profile', 'x-client-info'],
  exposedHeaders: ['Content-Range', 'X-Next-Cursor', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'x-trace-id', 'x-odb-read-from'],
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
});

server.addHook('onResponse', async (req, reply) => {
  const pid = (req.params as any)?.projectId;
  if (pid) requests.inc({ project_id: pid, method: req.method, status: String(reply.statusCode) });
});

server.get('/health', async () => ({ status: 'ok', service: 'api-service', timestamp: new Date().toISOString() }));
server.get('/health/ready', async (_req, reply) => {
  const checks: Record<string, string> = {};
  try { await poolerDb`SELECT 1`; checks['postgresql'] = 'healthy'; } catch { checks['postgresql'] = 'unhealthy'; }
  try { await redis.ping(); checks['redis'] = 'healthy'; } catch { checks['redis'] = 'unhealthy'; }
  const ok = Object.values(checks).every((v) => v === 'healthy');
  // a lagging / missing replica does not make the service unready: reads fall back to the primary
  return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks, read_replica: replicaStatus() });
});
server.get('/metrics', async (_req, reply) => reply.header('Content-Type', register.contentType).send(await register.metrics()));

await server.register(functionRoutes);

await server.register(async (api) => {
  api.addHook('preHandler', authMiddleware);
  api.addHook('preHandler', rateLimitMiddleware);
  api.get('/v1/:projectId', openApiHandler);
  api.get('/v1/:projectId/openapi.json', openApiHandler);
  await api.register(rpcRoutes);
  await api.register(restRoutes);
  await api.register(graphqlRoutes);
});

server.setNotFoundHandler((_req, reply) => { void reply.status(404).send({ error: 'Not Found' }); });
server.setErrorHandler((error, req, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) req.log.error({ err: error }, 'Unhandled error');
  void reply.status(status).send({ error: status >= 500 ? 'Internal Server Error' : error.name, message: status >= 500 ? 'Internal server error' : error.message });
});

try {
  await server.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  server.log.error(err, 'Failed to start');
  process.exit(1);
}

const shutdown = async () => {
  await server.close();
  await Promise.all([db.end({ timeout: 5 }), poolerDb.end({ timeout: 5 }), replicaDb?.end({ timeout: 5 })]);
  redis.disconnect(); redisSub.disconnect();
  await shutdownTracing(); process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
