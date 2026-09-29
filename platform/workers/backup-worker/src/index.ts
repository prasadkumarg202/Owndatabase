/**
 * OwnDatabase Backup Worker (Phase 7)
 *
 * Queue `owndatabase-backups`:
 *   backup.run      { backupId }   pg_dump of the project schema → AES-256-GCM encrypted file,
 *                                  checksum, `pg_restore --list` check and (optionally) a real
 *                                  test restore into a throw-away database
 *   restore.run     { restoreId }  restores a backup into the project schema. The current schema is
 *                                  renamed first and only dropped after the restore succeeded.
 *   retention.sweep {}             deletes backups past their project's retention period
 *
 * These are *logical, per-project* backups. Cluster-wide physical backups with
 * WAL archiving and point-in-time recovery are handled by pgBackRest
 * (infrastructure/pgbackrest) — see docs/backups.md.
 */
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import pino from 'pino';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { collectDefaultMetrics, register, Counter, Histogram } from 'prom-client';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', base: { service: 'backup-worker' } });
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const BACKUP_DIR = process.env['BACKUP_DIR'] ?? '/backups';
const KEY_HEX = process.env['BACKUP_ENCRYPTION_KEY'] || process.env['SECRET_ENCRYPTION_KEY'] || '';
const VERIFY_RESTORE = (process.env['BACKUP_VERIFY_RESTORE'] ?? 'true') === 'true';
const PG_BIN = process.env['PG_BIN_DIR'] ? process.env['PG_BIN_DIR'].replace(/\/$/, '') + '/' : '';
const PORT = Number(process.env['PORT'] ?? 3008);

if (!/^[0-9a-f]{64}$/i.test(KEY_HEX)) logger.warn('No 64-hex BACKUP_ENCRYPTION_KEY / SECRET_ENCRYPTION_KEY — backups will NOT be encrypted');

const sql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

collectDefaultMetrics({ prefix: 'owndatabase_backup_' });
const results = new Counter({ name: 'owndatabase_backup_jobs_total', help: 'Backup/restore jobs', labelNames: ['type', 'status'] });
const duration = new Histogram({ name: 'owndatabase_backup_duration_seconds', help: 'Backup duration', buckets: [1, 5, 15, 60, 300, 900, 3600] });
const lastSuccess = new Counter({ name: 'owndatabase_backup_last_success_timestamp_total', help: 'Incremented on each successful backup (use increase() for alerting)' });

// ── helpers ──────────────────────────────────────────────────────────────────

const MAGIC = Buffer.from('ODBBK1');

function pgEnv() {
  const u = new URL(DATABASE_URL);
  return {
    ...process.env,
    PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1),
  };
}

function run(cmd: string, args: string[], env: Record<string, string | undefined> = pgEnv()): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(PG_BIN + cmd, args, { env: env as NodeJS.ProcessEnv });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function encryptFile(src: string, dst: string) {
  if (!/^[0-9a-f]{64}$/i.test(KEY_HEX)) { await pipeline(createReadStream(src), createWriteStream(dst)); return false; }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY_HEX, 'hex'), iv);
  const out = createWriteStream(dst);
  const write = (b: Buffer) => new Promise<void>((resolve, reject) => out.write(b, (e) => (e ? reject(e) : resolve())));
  await write(Buffer.concat([MAGIC, iv]));
  for await (const chunk of createReadStream(src)) {
    const enc = cipher.update(chunk as Buffer);
    if (enc.length) await write(enc);
  }
  const fin = cipher.final();
  if (fin.length) await write(fin);
  await write(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => { out.end(); out.on('finish', resolve); out.on('error', reject); });
  return true;
}

async function decryptFile(src: string, dst: string) {
  const fh = await open(src, 'r');
  const head = Buffer.alloc(18);
  await fh.read(head, 0, 18, 0);
  const { size } = await fh.stat();
  if (!head.subarray(0, 6).equals(MAGIC)) { await fh.close(); await pipeline(createReadStream(src), createWriteStream(dst)); return; }
  const tag = Buffer.alloc(16);
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  const d = createDecipheriv('aes-256-gcm', Buffer.from(KEY_HEX, 'hex'), head.subarray(6, 18));
  d.setAuthTag(tag);
  await pipeline(createReadStream(src, { start: 18, end: size - 17 }), d, createWriteStream(dst));
}

async function sha256File(path: string) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';

// ── jobs ─────────────────────────────────────────────────────────────────────

async function backupRun(job: Job) {
  const { backupId } = job.data as { backupId: string };
  const [b] = await sql`
    SELECT b.*, p.db_schema, p.slug, COALESCE(c.retention_days, 30) AS retention_days
    FROM control_plane.backups b JOIN control_plane.projects p ON p.id = b.project_id
    LEFT JOIN control_plane.backup_configs c ON c.project_id = b.project_id
    WHERE b.id = ${backupId}`;
  if (!b) throw new Error(`Backup ${backupId} not found`);
  const started = Date.now();
  await sql`UPDATE control_plane.backups SET status = 'running', error_message = NULL WHERE id = ${backupId}`;

  const dir = join(BACKUP_DIR, b['project_id'] as string);
  await mkdir(dir, { recursive: true });
  const tmp = join(tmpdir(), `odb-${backupId}.dump`);
  const finalPath = join(dir, `${backupId}.dump.enc`);
  const schema = b['db_schema'] as string;
  try {
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--schema', schema, '--file', tmp]);
    const listing = await run('pg_restore', ['--list', tmp]);
    // only real table entries ("<id>; <oid> <oid> TABLE schema name"), not TABLE DATA or COMMENT … TABLE
    const tables = (listing.stdout.match(/^\d+; \d+ \d+ TABLE (?!DATA )/gm) ?? []).length;
    const encrypted = await encryptFile(tmp, finalPath);
    const size = (await stat(finalPath)).size;
    const checksum = await sha256File(finalPath);

    let verified = false;
    let verifyNote = 'pg_restore --list ok';
    if (VERIFY_RESTORE) {
      const testDb = `odb_verify_${backupId.replace(/-/g, '').slice(0, 20)}`;
      try {
        await sql.unsafe(`CREATE DATABASE ${ident(testDb)}`);
        const env = { ...pgEnv(), PGDATABASE: testDb };
        // The dump references platform objects (auth.users, control_plane trigger fn); create
        // minimal stand-ins so the test restore exercises the project's own objects.
        const tdb = postgres({ ...parseUrl(DATABASE_URL), database: testDb, max: 1, onnotice: () => {} });
        await tdb.unsafe(`
          CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users (id uuid primary key);
          CREATE SCHEMA IF NOT EXISTS control_plane;
          CREATE OR REPLACE FUNCTION control_plane.notify_realtime_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
          CREATE OR REPLACE FUNCTION control_plane.db_webhook_fire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
          CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
          CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
          CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
          DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
          END $$;`);
        await tdb.end();
        await run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', testDb, tmp], env);
        const t2 = postgres({ ...parseUrl(DATABASE_URL), database: testDb, max: 1, onnotice: () => {} });
        const [{ n }] = await t2`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = ${schema}` as any;
        await t2.end();
        verified = n === tables;
        verifyNote = `test restore ok: ${n}/${tables} tables`;
      } catch (err) {
        verifyNote = `test restore failed: ${(err as Error).message.slice(0, 500)}`;
      } finally {
        await sql.unsafe(`DROP DATABASE IF EXISTS ${ident(testDb)} WITH (FORCE)`).catch(() => {});
      }
    } else {
      verified = true;
    }

    await sql`
      UPDATE control_plane.backups SET
        status = ${verified ? 'verified' : 'completed'}, size_bytes = ${size}, duration_ms = ${Date.now() - started},
        storage_path = ${finalPath}, is_encrypted = ${encrypted}, is_verified = ${verified},
        verified_at = ${verified ? new Date() : null},
        expires_at = NOW() + make_interval(days => ${b['retention_days'] as number}),
        restore_point = ${new Date().toISOString()},
        metadata = metadata || ${sql.json({ checksum_sha256: checksum, tables, verify: verifyNote, format: 'pg_dump-custom', schema })}
      WHERE id = ${backupId}`;
    results.inc({ type: 'backup', status: 'success' });
    lastSuccess.inc();
    duration.observe((Date.now() - started) / 1000);
    logger.info({ backupId, size, tables, verified }, 'Backup completed');
    return { size, tables, verified };
  } catch (err) {
    await sql`UPDATE control_plane.backups SET status = 'failed', error_message = ${(err as Error).message.slice(0, 2000)}, duration_ms = ${Date.now() - started} WHERE id = ${backupId}`;
    await redis.publish('owndatabase:alerts', JSON.stringify({ type: 'BACKUP_FAILED', backupId, projectId: b['project_id'] })).catch(() => {});
    results.inc({ type: 'backup', status: 'failed' });
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

function parseUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

async function restoreRun(job: Job) {
  const { restoreId } = job.data as { restoreId: string };
  const [r] = await sql`
    SELECT r.*, b.storage_path, b.status AS backup_status, p.db_schema
    FROM control_plane.restores r
    JOIN control_plane.backups b ON b.id = r.backup_id
    JOIN control_plane.projects p ON p.id = r.project_id
    WHERE r.id = ${restoreId}`;
  if (!r) throw new Error(`Restore ${restoreId} not found`);
  await sql`UPDATE control_plane.restores SET status = 'running', started_at = NOW() WHERE id = ${restoreId}`;

  const schema = r['db_schema'] as string;
  const owner = `${schema}_owner`.slice(0, 63);
  const safety = `${schema}_prerestore_${Date.now().toString(36)}`.slice(0, 63);
  const tmp = join(tmpdir(), `odb-restore-${restoreId}.dump`);
  let renamed = false;
  try {
    if (r['target_time']) {
      throw new Error('Point-in-time restore needs the cluster-level pgBackRest setup (see docs/backups.md). Per-project backups restore to the moment they were taken.');
    }
    await decryptFile(r['storage_path'] as string, tmp);
    await run('pg_restore', ['--list', tmp]);

    await sql.unsafe(`ALTER SCHEMA ${ident(schema)} RENAME TO ${ident(safety)}`);
    renamed = true;
    await run('pg_restore', ['--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', '--dbname', pgEnv().PGDATABASE, tmp]);

    // Hand every restored object back to the project owner and re-apply API grants
    await sql.begin(async (tx) => {
      const s = ident(schema), o = ident(owner);
      await tx.unsafe(`ALTER SCHEMA ${s} OWNER TO ${o}`);
      const objs = await tx`
        SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relkind IN ('r','p','v','m','S','f')`;
      for (const x of objs) {
        const kind = ({ r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', S: 'SEQUENCE', f: 'FOREIGN TABLE' } as Record<string, string>)[x['relkind'] as string]!;
        if (kind === 'SEQUENCE') {
          const [owned] = await tx`SELECT 1 FROM pg_depend d JOIN pg_class c ON c.oid = d.objid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = ${x['relname'] as string} AND d.deptype IN ('a','i')`;
          if (owned) continue; // owned by a table column → follows the table
        }
        await tx.unsafe(`ALTER ${kind} ${s}.${ident(x['relname'] as string)} OWNER TO ${o}`);
      }
      const fns = await tx`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${schema}`;
      for (const f of fns) await tx.unsafe(`ALTER FUNCTION ${f['sig'] as string} OWNER TO ${o}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA ${s} TO anon, authenticated, service_role`);
      await tx.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${s} TO anon, authenticated, service_role`);
      await tx.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${s} TO anon, authenticated, service_role`);
      await tx.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO anon, authenticated, service_role`);
    });
    await sql.unsafe(`DROP SCHEMA ${ident(safety)} CASCADE`);
    renamed = false;
    await sql`UPDATE control_plane.restores SET status = 'completed', finished_at = NOW() WHERE id = ${restoreId}`;
    await redis.publish('odb:schema-changed', JSON.stringify({ projectId: r['project_id'] })).catch(() => {});
    results.inc({ type: 'restore', status: 'success' });
    logger.warn({ restoreId, schema }, 'Restore completed');
    return { ok: true };
  } catch (err) {
    if (renamed) {
      // put the original data back
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`).catch(() => {});
      await sql.unsafe(`ALTER SCHEMA ${ident(safety)} RENAME TO ${ident(schema)}`).catch((e) => logger.error({ e }, 'Could not roll back schema rename!'));
    }
    await sql`UPDATE control_plane.restores SET status = 'failed', finished_at = NOW(), error_message = ${(err as Error).message.slice(0, 2000)} WHERE id = ${restoreId}`;
    results.inc({ type: 'restore', status: 'failed' });
    throw err;
  } finally {
    await rm(tmp, { force: true });
  }
}

async function retentionSweep() {
  const expired = await sql`
    SELECT id, storage_path FROM control_plane.backups
    WHERE expires_at < NOW() AND status IN ('completed','verified','failed')`;
  for (const b of expired) {
    if (b['storage_path']) await rm(b['storage_path'] as string, { force: true });
    await sql`UPDATE control_plane.backups SET status = 'deleted', storage_path = NULL WHERE id = ${b['id'] as string}`;
  }
  logger.info({ deleted: expired.length }, 'Retention sweep done');
  return { deleted: expired.length };
}

const worker = new Worker('owndatabase-backups', async (job) => {
  if (job.name === 'backup.run') return backupRun(job);
  if (job.name === 'restore.run') return restoreRun(job);
  if (job.name === 'retention.sweep') return retentionSweep();
  throw new Error(`Unknown backup job ${job.name}`);
}, { connection, concurrency: 1, lockDuration: 10 * 60_000 });

worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'Backup job failed'));
worker.on('error', (err) => logger.error({ err: err.message }, 'Worker error'));

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(worker.isRunning() ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: worker.isRunning() ? 'ok' : 'down', service: 'backup-worker', encryption: /^[0-9a-f]{64}$/i.test(KEY_HEX) }));
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': register.contentType });
    return res.end(await register.metrics());
  }
  res.writeHead(404).end();
}).listen(PORT, () => logger.info({ port: PORT, dir: BACKUP_DIR }, 'Backup worker started'));

const shutdown = async () => { await worker.close(); await sql.end({ timeout: 2 }); redis.disconnect(); connection.disconnect(); process.exit(0); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
