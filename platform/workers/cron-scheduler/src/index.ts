/**
 * OwnDatabase Cron Scheduler (Phase 8 + Phase 7 backup scheduling)
 *
 * Every TICK_MS it:
 *   1. fires due rows of control_plane.cron_jobs  → job on `owndatabase-jobs`
 *   2. fires due project backups (backup_configs.full_backup_cron) → job on `owndatabase-backups`
 *
 * `next_run_at` is stored in the database, so restarts never skip or double-fire
 * a run. A Redis lock per (job, minute) keeps several scheduler replicas safe.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import pino from 'pino';
import http from 'node:http';
import cronParser from 'cron-parser';
import { collectDefaultMetrics, register, Counter } from 'prom-client';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', base: { service: 'cron-scheduler' } });
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const sql = postgres(process.env['DATABASE_URL'] ?? '', { max: 3, onnotice: () => {} });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const jobs = new Queue('owndatabase-jobs', { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
const backups = new Queue('owndatabase-backups', { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
const PORT = Number(process.env['PORT'] ?? 3007);
const TICK_MS = Number(process.env['CRON_TICK_MS'] ?? 15_000);

collectDefaultMetrics({ prefix: 'owndatabase_cron_' });
const fired = new Counter({ name: 'owndatabase_cron_fired_total', help: 'Cron firings', labelNames: ['kind'] });

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

export function nextRun(expr: string, from = new Date()): Date | null {
  try {
    return cronParser.parseExpression(MACROS[expr] ?? expr, { currentDate: from, utc: true }).next().toDate();
  } catch {
    return null;
  }
}

async function lock(key: string, seconds = 120): Promise<boolean> {
  return (await redis.set(`cron:lock:${key}`, '1', 'EX', seconds, 'NX')) === 'OK';
}

let lastTick: Date | null = null;

async function tick() {
  const now = new Date();

  // 1) user cron jobs
  const due = await sql`
    SELECT c.* FROM control_plane.cron_jobs c
    JOIN control_plane.projects p ON p.id = c.project_id AND p.status = 'active'
    WHERE c.is_enabled AND (c.next_run_at IS NULL OR c.next_run_at <= ${now})`;
  for (const c of due) {
    const next = nextRun(c['schedule'] as string, now);
    if (!next) {
      await sql`UPDATE control_plane.cron_jobs SET is_enabled = false, error_count = error_count + 1 WHERE id = ${c['id'] as string}`;
      logger.error({ id: c['id'], schedule: c['schedule'] }, 'Invalid cron expression — job disabled');
      continue;
    }
    if (c['next_run_at'] === null) {
      // first sighting: schedule only, do not fire immediately
      await sql`UPDATE control_plane.cron_jobs SET next_run_at = ${next} WHERE id = ${c['id'] as string}`;
      continue;
    }
    const slot = new Date(c['next_run_at'] as string).toISOString();
    if (!(await lock(`${c['id']}:${slot}`))) continue;
    try {
      await jobs.add(c['job_type'] as string, { projectId: c['project_id'], payload: c['payload'], cronJobId: c['id'] }, {
        attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { count: 1000 },
      });
      await sql`UPDATE control_plane.cron_jobs SET last_run_at = ${now}, next_run_at = ${next}, run_count = run_count + 1 WHERE id = ${c['id'] as string}`;
      fired.inc({ kind: 'job' });
      logger.info({ id: c['id'], name: c['name'], next }, 'Cron job fired');
    } catch (err) {
      await sql`UPDATE control_plane.cron_jobs SET error_count = error_count + 1 WHERE id = ${c['id'] as string}`;
      logger.error({ err, id: c['id'] }, 'Failed to enqueue cron job');
    }
  }

  // 2) scheduled backups (full backups; differential schedules map to full logical dumps too)
  const cfgs = await sql`
    SELECT b.*, p.db_schema FROM control_plane.backup_configs b
    JOIN control_plane.projects p ON p.id = b.project_id AND p.status = 'active'
    WHERE b.is_enabled`;
  for (const cfg of cfgs) {
    const key = `odb:backup-next:${cfg['project_id']}`;
    const stored = await redis.get(key);
    const next = nextRun(cfg['full_backup_cron'] as string, now);
    if (!stored) { if (next) await redis.set(key, next.toISOString()); continue; }
    if (new Date(stored) > now) continue;
    if (next) await redis.set(key, next.toISOString());
    if (!(await lock(`backup:${cfg['project_id']}:${stored}`, 3600))) continue;
    const [b] = await sql`
      INSERT INTO control_plane.backups (project_id, type, status, is_encrypted, metadata)
      VALUES (${cfg['project_id'] as string}, 'full', 'pending', true, ${sql.json({ trigger: 'schedule', schema: cfg['db_schema'] as string })})
      RETURNING id`;
    await backups.add('backup.run', { backupId: b!['id'] }, { jobId: `backup-${b!['id']}`, attempts: 2 });
    fired.inc({ kind: 'backup' });
    logger.info({ projectId: cfg['project_id'], backupId: b!['id'] }, 'Scheduled backup queued');
  }

  // 3) hourly retention sweep
  if (await lock(`retention:${now.toISOString().slice(0, 13)}`, 3700)) {
    await backups.add('retention.sweep', {}, { removeOnComplete: true });
  }
  lastTick = now;
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try { await tick(); } catch (err) { logger.error({ err }, 'Scheduler tick failed'); }
  finally { running = false; }
}
setInterval(loop, TICK_MS);
void loop();

// Control plane publishes this when cron jobs change → tick right away
void redisSub.subscribe('odb:cron-changed').catch(() => {});
redisSub.on('message', () => void loop());

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const stale = lastTick && Date.now() - lastTick.getTime() > TICK_MS * 4;
    res.writeHead(stale ? 503 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: stale ? 'stale' : 'ok', service: 'cron-scheduler', last_tick: lastTick }));
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': register.contentType });
    return res.end(await register.metrics());
  }
  res.writeHead(404).end();
}).listen(PORT, () => logger.info({ port: PORT, tickMs: TICK_MS }, 'Cron scheduler started'));

const shutdown = async () => { await jobs.close(); await backups.close(); await sql.end({ timeout: 2 }); redis.disconnect(); redisSub.disconnect(); process.exit(0); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
