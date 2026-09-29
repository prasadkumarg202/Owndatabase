/**
 * Project usage limits (see platform/shared/limits.ts for how each is enforced).
 *
 *   GET /api/projects/:id/limits   — limits, current usage and read-only state (project members)
 *   PUT /api/projects/:id/limits   — set limits; null removes one (platform admins only)
 *
 * startLimitWatcher() checks database sizes every minute and switches
 * projects over their database_bytes limit to read-only (and back).
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { audit, requirePlatformAdmin, requireProject } from '../lib/access.js';

export const LIMIT_KEYS = [
  'api_requests_per_day', 'function_invocations_per_day', 'storage_bytes', 'auth_users', 'realtime_connections', 'database_bytes',
] as const;
type LimitKey = typeof LIMIT_KEYS[number];

const limitValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const limitsSchema = z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<LimitKey, z.ZodOptional<typeof limitValue>>).strict();

/** Keeps only known keys with numeric values (nulls and unknown keys dropped). */
export function cleanLimits(input: Record<string, unknown> | null | undefined): Partial<Record<LimitKey, number>> {
  const out: Partial<Record<LimitKey, number>> = {};
  for (const k of LIMIT_KEYS) {
    const v = input?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  return out;
}

async function databaseBytes(schema: string): Promise<number> {
  const [r] = await db`
    SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint AS n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'm')`;
  return Number(r?.['n'] ?? 0);
}

/** Recomputes read-only state for one project; returns the new state. */
export async function checkDatabaseLimit(projectId: string): Promise<boolean> {
  const [p] = await db`SELECT db_schema, settings FROM control_plane.projects WHERE id = ${projectId}`;
  if (!p) return false;
  const settings = (p['settings'] ?? {}) as Record<string, any>;
  const max = cleanLimits(settings['limits']).database_bytes;
  const was = settings['quota_state']?.['db_read_only'] === true;
  const size = max === undefined && !was ? 0 : await databaseBytes(p['db_schema'] as string);
  const now = max !== undefined && size > max;
  if (now !== was) {
    await db`
      UPDATE control_plane.projects
      SET settings = jsonb_set(COALESCE(settings, '{}'), '{quota_state}',
                               COALESCE(settings->'quota_state', '{}') || ${db.json({ db_read_only: now, db_bytes: size, changed_at: new Date().toISOString() } as any)})
      WHERE id = ${projectId}`;
    await redis.publish('odb:project-changed', projectId).catch(() => {});
    await db`
      INSERT INTO control_plane.audit_logs (event_type, actor_type, target_type, target_id, project_id, metadata)
      VALUES (${now ? 'project.db_read_only_on' : 'project.db_read_only_off'}, 'system', 'project', ${projectId}, ${projectId},
              ${db.json({ database_bytes: size, limit: max ?? null } as any)})`;
    logger.warn({ projectId, size, limit: max, readOnly: now }, 'Database size limit state changed');
  }
  return now;
}

let watcher: NodeJS.Timeout | null = null;

export function startLimitWatcher(intervalMs = 60_000) {
  const tick = async () => {
    try {
      const rows = await db`
        SELECT id FROM control_plane.projects
        WHERE status <> 'deleting'
          AND (settings->'limits'->'database_bytes' IS NOT NULL OR (settings->'quota_state'->>'db_read_only')::boolean IS TRUE)`;
      for (const r of rows) await checkDatabaseLimit(r['id'] as string);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Limit watcher failed');
    }
  };
  watcher = setInterval(() => void tick(), intervalMs);
  watcher.unref();
  void tick();
}

export function stopLimitWatcher() {
  if (watcher) clearInterval(watcher);
}

export const limitRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (summary: string) => ({ schema: { tags: ['projects'], summary, security: [{ bearerAuth: [] }] } });

  server.get('/:id/limits', { ...auth, ...s('Project limits and usage') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const [row] = await db`SELECT settings FROM control_plane.projects WHERE id = ${id}`;
    const settings = (row?.['settings'] ?? {}) as Record<string, any>;
    const [u] = await db`
      SELECT
        (SELECT count(*)::int FROM auth.users WHERE project_id = ${id} AND deleted_at IS NULL) AS auth_users,
        (SELECT COALESCE(sum(o.size_bytes), 0)::bigint FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id
          WHERE b.project_id = ${id} AND NOT o.is_deleted) AS storage_bytes`;
    const day = new Date().toISOString().slice(0, 10);
    const today = await redis.hgetall(`odb:usage:${id}:${day}`).catch(() => ({} as Record<string, string>));
    const usage: Record<LimitKey, number | null> = {
      api_requests_per_day: Number(today['rest_requests'] ?? 0),
      function_invocations_per_day: Number(today['function_invocations'] ?? 0),
      storage_bytes: Number(u?.['storage_bytes'] ?? 0),
      auth_users: Number(u?.['auth_users'] ?? 0),
      realtime_connections: null, // live count: see Reports / Prometheus
      database_bytes: await databaseBytes(p.db_schema),
    };
    const limits = cleanLimits(settings['limits']);
    return reply.send({
      limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k] ?? null])),
      usage,
      read_only: settings['quota_state']?.['db_read_only'] === true,
    });
  });

  server.put('/:id/limits', { ...auth, ...s('Set project limits (platform admins)') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await requirePlatformAdmin(request, reply))) return;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const input = limitsSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const [row] = await db`SELECT settings FROM control_plane.projects WHERE id = ${id}`;
    if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    const merged: Record<string, unknown> = { ...cleanLimits((row['settings'] ?? {})['limits']) };
    for (const [k, v] of Object.entries(input.data)) {
      if (v === null) delete merged[k];
      else if (v !== undefined) merged[k] = v;
    }
    const limits = cleanLimits(merged);
    await db`UPDATE control_plane.projects SET settings = jsonb_set(COALESCE(settings, '{}'), '{limits}', ${db.json(limits as any)}) WHERE id = ${id}`;
    await redis.publish('odb:project-changed', id).catch(() => {});
    await audit(request, 'project.limits_updated', { type: 'project', id, projectId: id }, { limits });
    const readOnly = await checkDatabaseLimit(id);
    return reply.send({ limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k] ?? null])), read_only: readOnly });
  });
};
