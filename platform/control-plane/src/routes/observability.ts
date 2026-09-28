/**
 * Observability routes (Phase 6)
 *
 *   GET /api/projects/:id/logs?source=audit|auth|functions|platform&limit=
 *   GET /api/projects/:id/usage          — row counts, storage bytes, requests (Prometheus if configured)
 *   GET /api/observability/services      — health of every platform service
 *   GET /api/observability/alerts        — active Prometheus alerts (proxied)
 *   GET /api/observability/metrics?query= — instant PromQL query (proxied, owners only)
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { config } from '../config.js';
import { requireProject, userId } from '../lib/access.js';

const SERVICE_URLS: Record<string, string> = Object.fromEntries(
  (process.env['SERVICE_HEALTH_URLS'] ??
    'auth=http://auth-service:3002/health,rest=http://api-service:3003/health,realtime=http://realtime-service:3004/health,storage=http://storage-api:3005/health,queue-worker=http://queue-worker:3006/health,cron-scheduler=http://cron-scheduler:3007/health,backup-worker=http://backup-worker:3008/health')
    .split(',').map((pair) => pair.split('=') as [string, string]).filter(([k, v]) => k && v),
);

async function fetchJson(url: string, timeoutMs = 3000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const body = await res.text();
    try { return { ok: res.ok, status: res.status, body: JSON.parse(body) }; } catch { return { ok: res.ok, status: res.status, body }; }
  } finally {
    clearTimeout(t);
  }
}

async function promQuery(query: string): Promise<number | null> {
  if (!config.prometheusUrl) return null;
  try {
    const r = await fetchJson(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
    const v = r.body?.data?.result?.[0]?.value?.[1];
    return v === undefined ? 0 : Number(v);
  } catch {
    return null;
  }
}

export const observabilityRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (summary: string) => ({ schema: { tags: ['observability'], summary, security: [{ bearerAuth: [] }] } });

  server.get('/projects/:id/logs', { ...auth, ...s('Project logs') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const q = request.query as { source?: string; limit?: string; search?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const source = q.source ?? 'all';
    const search = q.search ? `%${q.search}%` : null;
    const out: any[] = [];

    if (source === 'all' || source === 'audit') {
      const rows = await db`
        SELECT a.timestamp, 'audit' AS source, a.event_type AS event, 'info' AS level, pu.email AS actor, a.ip_address, a.metadata
        FROM control_plane.audit_logs a LEFT JOIN control_plane.platform_users pu ON pu.id = a.actor_id
        WHERE a.project_id = ${id} ${search ? db`AND a.event_type ILIKE ${search}` : db``}
        ORDER BY a.timestamp DESC LIMIT ${limit}`;
      out.push(...rows);
    }
    if (source === 'all' || source === 'auth') {
      const rows = await db`
        SELECT l.timestamp, 'auth' AS source, l.event_type AS event,
               CASE WHEN l.event_type LIKE '%fail%' OR l.event_type LIKE '%locked%' THEN 'warn' ELSE 'info' END AS level,
               u.email AS actor, l.ip_address, l.metadata
        FROM auth.auth_audit_log l LEFT JOIN auth.users u ON u.id = l.user_id
        WHERE l.project_id = ${id} ${search ? db`AND l.event_type ILIKE ${search}` : db``}
        ORDER BY l.timestamp DESC LIMIT ${limit}`;
      out.push(...rows);
    }
    if (source === 'all' || source === 'functions') {
      const rows = await db`
        SELECT l.created_at AS timestamp, 'functions' AS source, f.slug || ' ' || l.status AS event,
               CASE WHEN l.status = 'success' THEN 'info' ELSE 'error' END AS level, NULL AS actor, NULL AS ip_address,
               jsonb_build_object('duration_ms', l.duration_ms, 'status_code', l.status_code, 'error', l.error, 'logs', left(l.logs, 2000)) AS metadata
        FROM control_plane.function_logs l JOIN control_plane.functions f ON f.id = l.function_id
        WHERE l.project_id = ${id} ${search ? db`AND f.slug ILIKE ${search}` : db``}
        ORDER BY l.created_at DESC LIMIT ${limit}`;
      out.push(...rows);
    }
    if ((source === 'all' || source === 'platform') && config.lokiUrl) {
      try {
        const query = `{service=~".+"} |= "${id}"`;
        const r = await fetchJson(`${config.lokiUrl}/loki/api/v1/query_range?limit=${limit}&query=${encodeURIComponent(query)}`);
        for (const stream of r.body?.data?.result ?? []) {
          for (const [ts, line] of stream.values ?? []) {
            out.push({ timestamp: new Date(Number(ts) / 1e6), source: 'platform', event: stream.stream?.container ?? 'log', level: 'info', actor: null, ip_address: null, metadata: { line } });
          }
        }
      } catch { /* Loki unreachable — skip */ }
    }
    out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return reply.send({ data: out.slice(0, limit), loki_enabled: !!config.lokiUrl });
  });

  server.get('/projects/:id/usage', { ...auth, ...s('Project usage') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const [u] = await db`
      SELECT
        (SELECT count(*)::int FROM auth.users WHERE project_id = ${id} AND deleted_at IS NULL) AS auth_users,
        (SELECT count(*)::int FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id WHERE u.project_id = ${id} AND (s.not_after IS NULL OR s.not_after > NOW())) AS active_sessions,
        (SELECT COALESCE(sum(o.size_bytes),0)::bigint FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id WHERE b.project_id = ${id} AND NOT o.is_deleted) AS storage_bytes,
        (SELECT count(*)::int FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id WHERE b.project_id = ${id} AND NOT o.is_deleted) AS storage_objects,
        (SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${p.db_schema} AND c.relkind IN ('r','m')) AS database_bytes,
        (SELECT count(*)::int FROM control_plane.function_logs WHERE project_id = ${id} AND created_at > NOW() - INTERVAL '24 hours') AS function_invocations_24h`;
    const day = new Date().toISOString().slice(0, 10);
    const counters = await redis.hgetall(`odb:usage:${id}:${day}`).catch(() => ({} as Record<string, string>));
    return reply.send({
      data: {
        ...u,
        storage_bytes: Number(u!['storage_bytes']),
        database_bytes: Number(u!['database_bytes']),
        today: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, Number(v)])),
        prometheus: config.prometheusUrl ? {
          rest_requests_5m: await promQuery(`sum(increase(owndatabase_api_requests_total{project_id="${id}"}[5m]))`),
          realtime_connections: await promQuery(`sum(owndatabase_realtime_active_connections{project_id="${id}"})`),
        } : null,
      },
    });
  });

  server.get('/observability/services', { ...auth, ...s('Service health') }, async (_request, reply) => {
    const results = await Promise.all(Object.entries(SERVICE_URLS).map(async ([name, url]) => {
      const start = Date.now();
      try {
        const r = await fetchJson(url, 2500);
        return { name, url, status: r.ok ? 'healthy' : 'unhealthy', http_status: r.status, latency_ms: Date.now() - start };
      } catch (err) {
        return { name, url, status: 'unreachable', error: (err as Error).message, latency_ms: Date.now() - start };
      }
    }));
    const pgStart = Date.now();
    let pg = 'healthy';
    try { await db`SELECT 1`; } catch { pg = 'unhealthy'; }
    results.unshift({ name: 'postgresql', url: 'internal', status: pg, latency_ms: Date.now() - pgStart } as any);
    const rStart = Date.now();
    let rd = 'healthy';
    try { await redis.ping(); } catch { rd = 'unhealthy'; }
    results.unshift({ name: 'redis', url: 'internal', status: rd, latency_ms: Date.now() - rStart } as any);
    results.unshift({ name: 'control-api', url: 'self', status: 'healthy', latency_ms: 0 } as any);
    return reply.send({ data: results });
  });

  server.get('/observability/alerts', { ...auth, ...s('Active alerts from Prometheus') }, async (_request, reply) => {
    if (!config.prometheusUrl) return reply.send({ data: [], configured: false });
    try {
      const r = await fetchJson(`${config.prometheusUrl}/api/v1/alerts`);
      const alerts = (r.body?.data?.alerts ?? []).map((a: any) => ({
        name: a.labels?.alertname, severity: a.labels?.severity ?? 'info', state: a.state,
        summary: a.annotations?.summary ?? '', description: a.annotations?.description ?? '',
        active_at: a.activeAt, labels: a.labels,
      }));
      const rules = await fetchJson(`${config.prometheusUrl}/api/v1/rules?type=alert`);
      const ruleCount = (rules.body?.data?.groups ?? []).reduce((n: number, g: any) => n + (g.rules?.length ?? 0), 0);
      return reply.send({ data: alerts, configured: true, rule_count: ruleCount });
    } catch (err) {
      return reply.send({ data: [], configured: true, error: (err as Error).message });
    }
  });

  server.get('/observability/metrics', { ...auth, ...s('Instant PromQL query') }, async (request, reply) => {
    if (!config.prometheusUrl) return reply.status(404).send({ error: 'Not Configured', message: 'PROMETHEUS_URL is not set' });
    const [owner] = await db`SELECT 1 FROM control_plane.organization_members WHERE user_id = ${userId(request)} AND role IN ('owner','admin') LIMIT 1`;
    if (!owner) return reply.status(403).send({ error: 'Forbidden' });
    const { query } = request.query as { query?: string };
    if (!query) return reply.status(400).send({ error: 'Validation Error', message: 'query is required' });
    const r = await fetchJson(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
    return reply.send(r.body);
  });
};
