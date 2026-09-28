/**
 * Functions, Queues and Cron routes (Phase 8)
 *
 * Functions
 *   GET    /api/projects/:id/functions
 *   POST   /api/projects/:id/functions             — create / deploy (new version if slug exists)
 *   GET    /api/projects/:id/functions/:slug
 *   PATCH  /api/projects/:id/functions/:slug
 *   DELETE /api/projects/:id/functions/:slug
 *   GET    /api/projects/:id/functions/:slug/logs
 *   POST   /api/projects/:id/functions/:slug/invoke-async  — queue a background invocation
 *
 * Queues
 *   GET    /api/projects/:id/queues                — job counts + recent jobs for this project
 *   POST   /api/projects/:id/queues/jobs           — enqueue a job
 *   POST   /api/projects/:id/queues/jobs/:jobId/retry
 *   GET    /api/projects/:id/queues/dlq            — dead-letter jobs
 *
 * Cron
 *   GET    /api/projects/:id/cron
 *   POST   /api/projects/:id/cron
 *   PATCH  /api/projects/:id/cron/:cronId
 *   DELETE /api/projects/:id/cron/:cronId
 *   POST   /api/projects/:id/cron/:cronId/run      — run now
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Job } from 'bullmq';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { audit, requireProject, userId, WRITE_ROLES } from '../lib/access.js';
import { jobsQueue } from '../lib/queues.js';

export const JOB_TYPES = ['function.invoke', 'webhook.dispatch', 'email.send', 'sql.run', 'noop', 'fail.test'] as const;
const CRON_RE = /^(@(yearly|monthly|weekly|daily|hourly)|(\S+\s+){4}\S+|(\S+\s+){5}\S+)$/;

const fnSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'Slug: lowercase letters, digits and hyphens'),
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(512 * 1024),
  timeout_ms: z.number().int().min(100).max(60_000).default(5000),
  memory_mb: z.number().int().min(32).max(1024).default(128),
  verify_jwt: z.boolean().default(true),
});

const jobSchema = z.object({
  type: z.enum(JOB_TYPES),
  payload: z.record(z.unknown()).default({}),
  delay_ms: z.number().int().min(0).max(7 * 86400_000).optional(),
  attempts: z.number().int().min(1).max(10).default(3),
});

const cronSchema = z.object({
  name: z.string().min(1).max(255),
  schedule: z.string().regex(CRON_RE, 'Invalid cron expression'),
  job_type: z.enum(JOB_TYPES),
  payload: z.record(z.unknown()).default({}),
  is_enabled: z.boolean().default(true),
});

function jobView(j: Job, state?: string) {
  return {
    id: j.id, name: j.name, state, data: j.data, attempts_made: j.attemptsMade,
    failed_reason: j.failedReason ?? null, return_value: j.returnvalue ?? null,
    created_at: new Date(j.timestamp).toISOString(),
    processed_at: j.processedOn ? new Date(j.processedOn).toISOString() : null,
    finished_at: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
  };
}

async function cronChanged() {
  await redis.publish('odb:cron-changed', '1').catch(() => {});
}

export const functionRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (tag: string, summary: string) => ({ schema: { tags: [tag], summary, security: [{ bearerAuth: [] }] } });

  // ── Functions ─────────────────────────────────────────────────────────────

  server.get('/:id/functions', { ...auth, ...s('functions', 'List functions') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const rows = await db`
      SELECT f.id, f.slug, f.name, f.runtime, f.timeout_ms, f.memory_mb, f.verify_jwt, f.version, f.is_active, f.created_at, f.updated_at,
             (SELECT count(*)::int FROM control_plane.function_logs l WHERE l.function_id = f.id AND l.created_at > NOW() - INTERVAL '24 hours') AS invocations_24h,
             (SELECT count(*)::int FROM control_plane.function_logs l WHERE l.function_id = f.id AND l.status <> 'success' AND l.created_at > NOW() - INTERVAL '24 hours') AS errors_24h
      FROM control_plane.functions f WHERE f.project_id = ${p.id} ORDER BY f.slug`;
    return reply.send({ data: rows });
  });

  server.post('/:id/functions', { ...auth, ...s('functions', 'Deploy a function') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = fnSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const f = input.data;
    if (!/export\s+default|module\.exports|exports\.handler|export\s+(async\s+)?function\s+handler/.test(f.code)) {
      return reply.status(400).send({ error: 'Validation Error', message: 'Code must export a handler: `export default async function (req) { ... }`' });
    }
    const [row] = await db`
      INSERT INTO control_plane.functions (project_id, slug, name, code, timeout_ms, memory_mb, verify_jwt, created_by)
      VALUES (${id}, ${f.slug}, ${f.name ?? f.slug}, ${f.code}, ${f.timeout_ms}, ${f.memory_mb}, ${f.verify_jwt}, ${userId(request)})
      ON CONFLICT (project_id, slug) DO UPDATE SET
        code = EXCLUDED.code, name = EXCLUDED.name, timeout_ms = EXCLUDED.timeout_ms, memory_mb = EXCLUDED.memory_mb,
        verify_jwt = EXCLUDED.verify_jwt, version = control_plane.functions.version + 1, is_active = true
      RETURNING id, slug, name, version, timeout_ms, memory_mb, verify_jwt, created_at, updated_at`;
    await redis.publish('odb:function-changed', `${id}:${f.slug}`).catch(() => {});
    await audit(request, 'function.deployed', { type: 'function', id: row!['id'] as string, projectId: id }, { slug: f.slug, version: row!['version'] });
    return reply.status(201).send(row);
  });

  async function loadFn(request: any, reply: any, roles: any = null) {
    const { id, slug } = request.params as { id: string; slug: string };
    const p = await requireProject(request, reply, id, roles);
    if (!p) return null;
    const [fn] = await db`SELECT * FROM control_plane.functions WHERE project_id = ${id} AND slug = ${slug}`;
    if (!fn) { reply.status(404).send({ error: 'Not Found', message: 'Function not found' }); return null; }
    return { p, fn };
  }

  server.get('/:id/functions/:slug', { ...auth, ...s('functions', 'Get function') }, async (request, reply) => {
    const r = await loadFn(request, reply);
    if (!r) return;
    return reply.send(r.fn);
  });

  server.patch('/:id/functions/:slug', { ...auth, ...s('functions', 'Update function settings') }, async (request, reply) => {
    const r = await loadFn(request, reply, WRITE_ROLES);
    if (!r) return;
    const input = fnSchema.partial().omit({ slug: true }).extend({ is_active: z.boolean().optional() }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const b = input.data;
    const [row] = await db`
      UPDATE control_plane.functions SET
        name = COALESCE(${b.name ?? null}, name),
        code = COALESCE(${b.code ?? null}, code),
        timeout_ms = COALESCE(${b.timeout_ms ?? null}, timeout_ms),
        memory_mb = COALESCE(${b.memory_mb ?? null}, memory_mb),
        verify_jwt = COALESCE(${b.verify_jwt ?? null}, verify_jwt),
        is_active = COALESCE(${b.is_active ?? null}, is_active),
        version = CASE WHEN ${b.code ?? null}::text IS NULL THEN version ELSE version + 1 END
      WHERE id = ${r.fn['id'] as string}
      RETURNING id, slug, name, version, timeout_ms, memory_mb, verify_jwt, is_active, updated_at`;
    await redis.publish('odb:function-changed', `${r.p.id}:${r.fn['slug']}`).catch(() => {});
    return reply.send(row);
  });

  server.delete('/:id/functions/:slug', { ...auth, ...s('functions', 'Delete function') }, async (request, reply) => {
    const r = await loadFn(request, reply, WRITE_ROLES);
    if (!r) return;
    await db`DELETE FROM control_plane.functions WHERE id = ${r.fn['id'] as string}`;
    await redis.publish('odb:function-changed', `${r.p.id}:${r.fn['slug']}`).catch(() => {});
    await audit(request, 'function.deleted', { type: 'function', id: r.fn['id'] as string, projectId: r.p.id });
    return reply.send({ success: true });
  });

  server.get('/:id/functions/:slug/logs', { ...auth, ...s('functions', 'Function invocation logs') }, async (request, reply) => {
    const r = await loadFn(request, reply);
    if (!r) return;
    const rows = await db`
      SELECT id, version, status, status_code, duration_ms, logs, error, created_at
      FROM control_plane.function_logs WHERE function_id = ${r.fn['id'] as string}
      ORDER BY created_at DESC LIMIT 100`;
    return reply.send({ data: rows });
  });

  server.post('/:id/functions/:slug/invoke-async', { ...auth, ...s('functions', 'Queue a background invocation') }, async (request, reply) => {
    const r = await loadFn(request, reply, WRITE_ROLES);
    if (!r) return;
    const job = await jobsQueue().add('function.invoke', {
      projectId: r.p.id, payload: { slug: r.fn['slug'], body: request.body ?? {} },
    });
    return reply.status(202).send({ job_id: job.id, queued: true });
  });

  // ── Queues ────────────────────────────────────────────────────────────────

  server.get('/:id/queues', { ...auth, ...s('queues', 'Queue overview for this project') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const q = jobsQueue();
    const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    const states = ['active', 'waiting', 'delayed', 'completed', 'failed'] as const;
    const jobs: any[] = [];
    for (const state of states) {
      const list = await q.getJobs([state], 0, 199);
      for (const j of list) if (j?.data?.projectId === p.id) jobs.push(jobView(j, state));
    }
    jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const project_counts: Record<string, number> = {};
    for (const j of jobs) project_counts[j.state] = (project_counts[j.state] ?? 0) + 1;
    const dlq = await redis.llen(`odb:dlq:${p.id}`);
    return reply.send({
      data: {
        queue: q.name,
        counts: project_counts,
        global_counts: counts,
        dead_letter: dlq,
        jobs: jobs.slice(0, 100),
        job_types: JOB_TYPES,
      },
    });
  });

  server.post('/:id/queues/jobs', { ...auth, ...s('queues', 'Enqueue a job') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = jobSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const job = await jobsQueue().add(input.data.type, { projectId: id, payload: input.data.payload }, {
      attempts: input.data.attempts,
      ...(input.data.delay_ms ? { delay: input.data.delay_ms } : {}),
    });
    await audit(request, 'job.enqueued', { type: 'job', id: String(job.id), projectId: id }, { type: input.data.type });
    return reply.status(202).send({ id: job.id, name: job.name, state: input.data.delay_ms ? 'delayed' : 'waiting' });
  });

  server.get('/:id/queues/jobs/:jobId', { ...auth, ...s('queues', 'Job details') }, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const job = await Job.fromId(jobsQueue(), jobId);
    if (!job || job.data?.projectId !== id) return reply.status(404).send({ error: 'Not Found', message: 'Job not found' });
    return reply.send(jobView(job, await job.getState()));
  });

  server.post('/:id/queues/jobs/:jobId/retry', { ...auth, ...s('queues', 'Retry a failed job') }, async (request, reply) => {
    const { id, jobId } = request.params as { id: string; jobId: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const job = await Job.fromId(jobsQueue(), jobId);
    if (!job || job.data?.projectId !== id) return reply.status(404).send({ error: 'Not Found', message: 'Job not found' });
    if ((await job.getState()) !== 'failed') return reply.status(409).send({ error: 'Conflict', message: 'Only failed jobs can be retried' });
    await job.retry();
    return reply.send({ success: true, id: job.id });
  });

  server.get('/:id/queues/dlq', { ...auth, ...s('queues', 'Dead-letter queue') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const raw = await redis.lrange(`odb:dlq:${p.id}`, 0, 99);
    return reply.send({ data: raw.map((r) => { try { return JSON.parse(r); } catch { return { raw: r }; } }) });
  });

  // ── Cron ──────────────────────────────────────────────────────────────────

  server.get('/:id/cron', { ...auth, ...s('cron', 'List cron jobs') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const rows = await db`SELECT * FROM control_plane.cron_jobs WHERE project_id = ${p.id} ORDER BY name`;
    return reply.send({ data: rows });
  });

  server.post('/:id/cron', { ...auth, ...s('cron', 'Create cron job') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = cronSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const c = input.data;
    try {
      const [row] = await db`
        INSERT INTO control_plane.cron_jobs (project_id, name, schedule, job_type, payload, is_enabled)
        VALUES (${id}, ${c.name}, ${c.schedule}, ${c.job_type}, ${db.json(c.payload as any)}, ${c.is_enabled}) RETURNING *`;
      await cronChanged();
      await audit(request, 'cron.created', { type: 'cron_job', id: row!['id'] as string, projectId: id }, { name: c.name, schedule: c.schedule });
      return reply.status(201).send(row);
    } catch (err: any) {
      if (err.code === '23505') return reply.status(409).send({ error: 'Conflict', message: 'A cron job with this name already exists' });
      throw err;
    }
  });

  server.patch('/:id/cron/:cronId', { ...auth, ...s('cron', 'Update cron job') }, async (request, reply) => {
    const { id, cronId } = request.params as { id: string; cronId: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = cronSchema.partial().safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const c = input.data;
    const [row] = await db`
      UPDATE control_plane.cron_jobs SET
        name = COALESCE(${c.name ?? null}, name), schedule = COALESCE(${c.schedule ?? null}, schedule),
        job_type = COALESCE(${c.job_type ?? null}, job_type),
        payload = COALESCE(${c.payload ? db.json(c.payload as any) : null}, payload),
        is_enabled = COALESCE(${c.is_enabled ?? null}, is_enabled), updated_at = NOW()
      WHERE id = ${cronId} AND project_id = ${id} RETURNING *`;
    if (!row) return reply.status(404).send({ error: 'Not Found', message: 'Cron job not found' });
    await cronChanged();
    return reply.send(row);
  });

  server.delete('/:id/cron/:cronId', { ...auth, ...s('cron', 'Delete cron job') }, async (request, reply) => {
    const { id, cronId } = request.params as { id: string; cronId: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const rows = await db`DELETE FROM control_plane.cron_jobs WHERE id = ${cronId} AND project_id = ${id} RETURNING id`;
    if (!rows.length) return reply.status(404).send({ error: 'Not Found', message: 'Cron job not found' });
    await cronChanged();
    return reply.send({ success: true });
  });

  server.post('/:id/cron/:cronId/run', { ...auth, ...s('cron', 'Run a cron job now') }, async (request, reply) => {
    const { id, cronId } = request.params as { id: string; cronId: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const [c] = await db`SELECT * FROM control_plane.cron_jobs WHERE id = ${cronId} AND project_id = ${id}`;
    if (!c) return reply.status(404).send({ error: 'Not Found', message: 'Cron job not found' });
    const job = await jobsQueue().add(c['job_type'] as string, { projectId: id, payload: c['payload'], cronJobId: cronId });
    await db`UPDATE control_plane.cron_jobs SET last_run_at = NOW(), run_count = run_count + 1 WHERE id = ${cronId}`;
    return reply.status(202).send({ job_id: job.id });
  });
};
