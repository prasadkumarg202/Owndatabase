/**
 * Serverless functions (Phase 8).
 *
 *   ANY /functions/v1/:projectId/:slug[/*]
 *
 * Code is deployed through the control API (control_plane.functions) and
 * executed by the isolated functions runtime (platform/workers/functions-runtime):
 * a separate container with no access to the platform network, one process per
 * invocation under a per-project uid.
 * The caller must send the project API key; functions with verify_jwt=true
 * also need a signed-in user token or a service_role key.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createDecipheriv } from 'node:crypto';
import { Counter, Histogram } from 'prom-client';
import { db } from '../lib/db.js';
import { config } from '../config.js';
import { AuthError, type RequestAuth } from '../lib/platform-auth.js';
import { platform } from '../middleware/auth.js';
import { redis } from '../lib/schema-cache.js';

const invocations = new Counter({ name: 'owndatabase_functions_invocations_total', help: 'Function invocations', labelNames: ['project_id', 'status'] });
const durations = new Histogram({ name: 'owndatabase_functions_duration_seconds', help: 'Function duration', buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30] });

let running = 0;

function decrypt(buf: Buffer): string | null {
  if (!config.SECRET_ENCRYPTION_KEY) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(config.SECRET_ENCRYPTION_KEY, 'hex'), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return d.update(buf.subarray(28)) + d.final('utf8');
  } catch { return null; }
}

async function projectSecrets(projectId: string): Promise<Record<string, string>> {
  const rows = await db`SELECT name, value_encrypted FROM control_plane.secrets WHERE project_id = ${projectId} AND is_active`;
  const out: Record<string, string> = {};
  for (const r of rows) {
    const v = decrypt(r['value_encrypted'] as Buffer);
    if (v !== null) out[r['name'] as string] = v;
  }
  return out;
}

export interface RunResult { status: number; headers: Record<string, string>; body: string; logs: string[]; error?: string; timedOut?: boolean; durationMs: number }

export async function runFunction(fn: any, request: Record<string, unknown>, env: Record<string, string>): Promise<RunResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.FUNCTIONS_RUNTIME_URL.replace(/\/$/, '')}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.FUNCTIONS_RUNTIME_TOKEN}` },
      body: JSON.stringify({
        project_id: fn.project_id, function_id: fn.id, version: fn.version, code: fn.code,
        memory_mb: fn.memory_mb, timeout_ms: fn.timeout_ms, request, env,
      }),
      // the runtime enforces the function timeout; this only guards against a hung runtime
      signal: AbortSignal.timeout(Number(fn.timeout_ms) + 10_000),
    });
    if (res.status === 503) {
      return { status: 503, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: 'Busy', message: 'Too many concurrent function invocations' }), logs: [], error: 'runtime busy', durationMs: Date.now() - started };
    }
    if (!res.ok) throw new Error(`functions runtime returned ${res.status}`);
    return (await res.json()) as RunResult;
  } catch (err) {
    return { status: 502, headers: {}, body: JSON.stringify({ error: 'Functions runtime unavailable' }), logs: [], error: String(err), durationMs: Date.now() - started };
  }
}

async function logInvocation(fn: any, r: RunResult) {
  const status = r.timedOut ? 'timeout' : r.error ? 'error' : 'success';
  invocations.inc({ project_id: fn.project_id, status });
  durations.observe(r.durationMs / 1000);
  await db`
    INSERT INTO control_plane.function_logs (function_id, project_id, version, status, status_code, duration_ms, logs, error)
    VALUES (${fn.id}, ${fn.project_id}, ${fn.version}, ${status}, ${r.status}, ${r.durationMs}, ${r.logs.join('\n').slice(0, 100_000)}, ${r.error ?? null})`;
  const day = new Date().toISOString().slice(0, 10);
  await redis.hincrby(`odb:usage:${fn.project_id}:${day}`, 'function_invocations', 1).catch(() => {});
}

const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-odb-internal']);

export default async function functionRoutes(server: FastifyInstance) {
  server.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.FUNCTIONS_ENABLED) return reply.status(503).send({ error: 'Functions are disabled on this server' });
    const { projectId, slug } = req.params as { projectId: string; slug: string };

    let auth: RequestAuth | null = null;
    const internal = req.headers['x-odb-internal'];
    if (typeof internal === 'string') {
      try {
        const claims = await platform.verifyInternal(internal);
        if (claims['project_id'] !== projectId) throw new Error('project mismatch');
        const project = await platform.getProject(projectId);
        if (!project) return reply.status(404).send({ error: 'Not Found' });
        auth = { project, key: { id: 'internal', project_id: projectId, type: 'service_role' }, role: 'service_role', claims: { role: 'service_role' }, userId: null };
      } catch {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid internal token' });
      }
    } else {
      try {
        auth = await platform.authenticate(projectId, req.headers as any, req.query as any);
      } catch (err) {
        if (err instanceof AuthError) return reply.status(err.statusCode).send({ error: 'Unauthorized', message: err.message });
        throw err;
      }
    }

    const [fn] = await db`SELECT * FROM control_plane.functions WHERE project_id = ${projectId} AND slug = ${slug}`;
    if (!fn || !fn['is_active']) return reply.status(404).send({ error: 'Not Found', message: `Function '${slug}' not found` });
    if (fn['verify_jwt'] && auth.role === 'anon') {
      return reply.status(401).send({ error: 'Unauthorized', message: 'This function requires a signed-in user (Authorization: Bearer <access token>)' });
    }
    if (running >= config.FUNCTIONS_MAX_CONCURRENCY) {
      return reply.status(503).header('Retry-After', 1).send({ error: 'Busy', message: 'Too many concurrent function invocations' });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && typeof v === 'string') headers[k] = v;
    const rest = (req.params as Record<string, string>)['*'] ?? '';
    // Functions reach the platform through the gateway (the only internal address they may call)
    const gateway = config.FUNCTIONS_GATEWAY_URL.replace(/\/$/, '');
    const env = {
      ...(await projectSecrets(projectId)),
      ODB_PROJECT_ID: projectId,
      ODB_URL: gateway,
      ODB_PUBLIC_URL: config.PUBLIC_URL,
      ODB_REST_URL: `${gateway}/rest/v1/${projectId}`,
      ODB_AUTH_URL: `${gateway}/auth/v1/${projectId}`,
      ODB_STORAGE_URL: `${gateway}/storage/v1/${projectId}`,
      ODB_FUNCTIONS_URL: `${gateway}/functions/v1/${projectId}`,
    };
    const request = {
      method: req.method,
      url: req.url,
      path: '/' + rest,
      headers,
      query: req.query,
      body: req.body ?? null,
      user: auth.claims && auth.userId ? { id: auth.userId, email: auth.claims['email'] ?? null, role: auth.role } : null,
    };
    (request.headers as any)['x-odb-role'] = auth.role;
    if (auth.userId) (request.headers as any)['x-odb-user-id'] = auth.userId;

    running++;
    let r: RunResult;
    try {
      r = await runFunction(fn, request, env);
    } finally {
      running--;
    }
    await logInvocation(fn, r);
    const safeHeaders = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP_HEADERS.has(k.toLowerCase())));
    return reply.status(r.status).headers({ ...safeHeaders, 'x-odb-function-version': String(fn['version']), 'x-odb-duration-ms': String(r.durationMs) }).send(r.body);
  };

  server.all('/functions/v1/:projectId/:slug', handler);
  server.all('/functions/v1/:projectId/:slug/*', handler);
}
