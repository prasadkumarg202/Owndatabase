/**
 * OwnDatabase Queue Worker (Phase 8)
 *
 * Processes jobs from the `owndatabase-jobs` BullMQ queue:
 *   function.invoke   { slug, body }                          → runs a deployed function
 *   webhook.dispatch  { url, method?, headers?, body?, secret? } → HTTP call (HMAC-signed when secret given)
 *   email.send        { to, subject, text, html? }            → SMTP (logged when SMTP is not configured)
 *   sql.run           { query }                               → SQL as the project owner role
 *   noop / fail.test                                          → for health checks and DLQ tests
 *
 * Retries use exponential backoff (attempts set per job). Jobs that exhaust
 * their attempts are copied to the project's dead-letter list `odb:dlq:<projectId>`.
 */
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import pino from 'pino';
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createDecipheriv, createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import nodemailer from 'nodemailer';
import { collectDefaultMetrics, register, Counter } from 'prom-client';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', base: { service: 'queue-worker' } });
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const JWT_SECRET = process.env['JWT_SECRET'] ?? '';
const API_SERVICE_URL = process.env['API_SERVICE_URL'] ?? 'http://api-service:3003';
const ALLOW_PRIVATE_WEBHOOKS = process.env['WEBHOOK_ALLOW_PRIVATE'] === 'true';
const ENC_KEY = process.env['SECRET_ENCRYPTION_KEY'];
const PORT = Number(process.env['PORT'] ?? 3006);
const CONCURRENCY = Number(process.env['QUEUE_CONCURRENCY'] ?? 5);

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const sql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });

collectDefaultMetrics({ prefix: 'owndatabase_queue_' });
const processed = new Counter({ name: 'owndatabase_queue_jobs_total', help: 'Processed jobs', labelNames: ['type', 'status'] });

const mailer = process.env['SMTP_HOST']
  ? nodemailer.createTransport({
      host: process.env['SMTP_HOST'], port: Number(process.env['SMTP_PORT'] ?? 587), secure: process.env['SMTP_PORT'] === '465',
      auth: process.env['SMTP_USER'] ? { user: process.env['SMTP_USER'], pass: process.env['SMTP_PASSWORD'] ?? '' } : undefined,
    })
  : null;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
}

async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) webhooks are allowed');
  if (ALLOW_PRIVATE_WEBHOOKS) return;
  const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('Webhooks to private / internal addresses are blocked (set WEBHOOK_ALLOW_PRIVATE=true to allow)');
}

function decrypt(hex: string): string {
  if (!ENC_KEY) throw new Error('SECRET_ENCRYPTION_KEY is not set');
  const buf = Buffer.from(hex, 'hex');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY, 'hex'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return d.update(buf.subarray(28)) + d.final('utf8');
}

async function runSqlAsOwner(projectId: string, query: string) {
  const [p] = await sql`SELECT db_schema, metadata->>'db_password_enc' AS enc FROM control_plane.projects WHERE id = ${projectId}`;
  if (!p?.['enc']) throw new Error('Project has no database owner credentials (re-run provisioning)');
  const u = new URL(DATABASE_URL);
  u.username = `${p['db_schema']}_owner`.slice(0, 63);
  u.password = encodeURIComponent(decrypt(p['enc'] as string));
  const owner = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    return await owner.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = 30000`);
      const r = await tx.unsafe(query);
      return { rows: r.length, command: (r as any).command };
    });
  } finally {
    await owner.end({ timeout: 2 });
  }
}

async function processJob(job: Job) {
  const { projectId, payload = {} } = job.data as { projectId?: string; payload?: Record<string, any> };
  logger.info({ jobId: job.id, type: job.name, projectId }, 'Processing job');
  switch (job.name) {
    case 'noop':
      return { ok: true, echo: payload };

    case 'fail.test':
      throw new Error(payload['message'] ?? 'Intentional failure (fail.test)');

    case 'function.invoke': {
      if (!projectId || !payload['slug']) throw new Error('function.invoke needs projectId and payload.slug');
      const token = await new SignJWT({ project_id: projectId, typ: 'internal', job_id: String(job.id) })
        .setProtectedHeader({ alg: 'HS256' }).setIssuer('owndatabase-internal').setIssuedAt().setExpirationTime('2m')
        .sign(new TextEncoder().encode(JWT_SECRET));
      const res = await fetch(`${API_SERVICE_URL}/functions/v1/${projectId}/${encodeURIComponent(payload['slug'])}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-odb-internal': token }, body: JSON.stringify(payload['body'] ?? {}),
        signal: AbortSignal.timeout(65_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Function returned ${res.status}: ${text.slice(0, 500)}`);
      return { status: res.status, body: text.slice(0, 10_000) };
    }

    case 'webhook.dispatch': {
      const url = String(payload['url'] ?? '');
      await assertPublicUrl(url);
      const body = payload['body'] === undefined ? undefined : typeof payload['body'] === 'string' ? payload['body'] : JSON.stringify(payload['body']);
      const headers: Record<string, string> = { 'user-agent': 'OwnDatabase-Webhooks/1.0', ...(payload['headers'] ?? {}) };
      if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      if (payload['secret'] && body) {
        const ts = Math.floor(Date.now() / 1000);
        headers['x-odb-timestamp'] = String(ts);
        headers['x-odb-signature'] = 'sha256=' + createHmac('sha256', String(payload['secret'])).update(`${ts}.${body}`).digest('hex');
      }
      const res = await fetch(url, { method: payload['method'] ?? 'POST', headers, body, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      if (res.status >= 300) throw new Error(`Webhook responded ${res.status}`);
      return { status: res.status };
    }

    case 'email.send': {
      if (!payload['to'] || !payload['subject']) throw new Error('email.send needs to and subject');
      if (mailer) {
        await mailer.sendMail({ from: process.env['SMTP_FROM'] ?? 'no-reply@owndatabase.local', to: payload['to'], subject: payload['subject'], text: payload['text'], html: payload['html'] });
        return { sent: true };
      }
      logger.info({ to: payload['to'], subject: payload['subject'] }, 'SMTP not configured — email logged only');
      return { sent: false, logged: true };
    }

    case 'sql.run': {
      if (!projectId || !payload['query']) throw new Error('sql.run needs projectId and payload.query');
      return runSqlAsOwner(projectId, String(payload['query']));
    }

    default:
      throw new Error(`Unknown job type: ${job.name}`);
  }
}

const worker = new Worker('owndatabase-jobs', processJob, {
  connection,
  concurrency: CONCURRENCY,
  settings: { backoffStrategy: (attempts: number) => Math.min(2 ** attempts * 1000, 60_000) },
});

worker.on('completed', (job) => processed.inc({ type: job.name, status: 'completed' }));
worker.on('failed', async (job, err) => {
  processed.inc({ type: job?.name ?? 'unknown', status: 'failed' });
  logger.warn({ jobId: job?.id, err: err.message, attempt: job?.attemptsMade }, 'Job failed');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    const projectId = (job.data as any)?.projectId ?? 'unknown';
    await redis.lpush(`odb:dlq:${projectId}`, JSON.stringify({
      id: job.id, name: job.name, data: job.data, error: err.message, attempts: job.attemptsMade, failed_at: new Date().toISOString(),
    }));
    await redis.ltrim(`odb:dlq:${projectId}`, 0, 999);
  }
});
worker.on('error', (err) => logger.error({ err: err.message }, 'Worker error'));

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(worker.isRunning() ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: worker.isRunning() ? 'ok' : 'down', service: 'queue-worker' }));
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': register.contentType });
    return res.end(await register.metrics());
  }
  res.writeHead(404).end();
}).listen(PORT, () => logger.info({ port: PORT }, 'Queue worker started'));

const shutdown = async () => { await worker.close(); await sql.end({ timeout: 2 }); connection.disconnect(); redis.disconnect(); process.exit(0); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
