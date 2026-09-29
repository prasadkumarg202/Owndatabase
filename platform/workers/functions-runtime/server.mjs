// OwnDatabase functions runtime.
//
// Runs user functions for the data API (api-service), which is its only client
// (POST /run with a shared bearer token, on an internal Docker network). Each
// invocation is a fresh Node.js process:
//
//   * under a per-project Linux uid (20000-29999), never root;
//   * with the Node permission model: it can read only its own code file and the
//     runner — no file writes, child processes, worker threads or native addons;
//   * with a heap limit, a hard timeout (SIGKILL) and a stripped environment;
//   * behind the firewall set up by entrypoint.sh: the uid range cannot reach
//     private / internal addresses, only the public internet and the platform
//     gateway (FUNCTIONS_GATEWAY_URL).
//
// This container has no access to the platform network, database or Redis.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3010);
const TOKEN = process.env.FUNCTIONS_RUNTIME_TOKEN ?? '';
const MAX_CONCURRENCY = Number(process.env.FUNCTIONS_MAX_CONCURRENCY ?? 8);
const WORK_DIR = process.env.WORK_DIR ?? '/work';
const RUNNER = new URL('./runner.mjs', import.meta.url).pathname;
const UID_BASE = 20000, UID_RANGE = 10000;

if (TOKEN.length < 32) {
  console.error('FUNCTIONS_RUNTIME_TOKEN must be set (at least 32 characters)');
  process.exit(1);
}
if (process.getuid?.() !== 0) console.warn('Not running as root: invocations cannot switch to per-project uids');

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'functions-runtime', msg, ...extra }));

/** Stable uid per project, so one project can never signal or inspect another's processes. */
export function uidFor(projectId) {
  return UID_BASE + (createHash('sha256').update(String(projectId)).digest().readUInt32BE(0) % UID_RANGE);
}

// Directories stay root-owned and unlistable (0711); each code file is owned by
// its project's uid and readable only by it (0400).
function codeFileFor(uid, fn) {
  const dir = join(WORK_DIR, String(uid));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o711 });
    chmodSync(dir, 0o711);
  }
  const file = join(dir, `${String(fn.function_id).replace(/[^\w-]/g, '')}-v${Number(fn.version)}.mjs`);
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, fn.code, { mode: 0o400 });
    if (process.getuid?.() === 0) chownSync(tmp, uid, uid);
    renameSync(tmp, file);
  }
  return file;
}

let running = 0;

function run(fn) {
  const uid = uidFor(fn.project_id);
  const codeFile = codeFileFor(uid, fn);
  const memory = Math.min(Math.max(Number(fn.memory_mb) || 128, 16), 1024);
  const timeout = Math.min(Math.max(Number(fn.timeout_ms) || 5000, 100), 300_000);
  const args = [
    `--max-old-space-size=${memory}`,
    '--permission', `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${codeFile}`,
    RUNNER,
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      uid: process.getuid?.() === 0 ? uid : undefined,
      gid: process.getuid?.() === 0 ? uid : undefined,
      cwd: '/',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', TZ: 'UTC', HOME: '/nonexistent' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '', done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: 504, headers: {}, body: JSON.stringify({ error: 'Function timed out', timeout_ms: timeout }), logs: [], timedOut: true, error: `Timed out after ${timeout}ms` });
    }, timeout);
    child.stdout.on('data', (d) => { out += d; if (out.length > 6_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { if (err.length < 20_000) err += d; });
    child.on('error', (e) => finish({ status: 500, headers: {}, body: JSON.stringify({ error: 'Function could not start' }), logs: [], error: String(e) }));
    child.on('close', (code, signal) => {
      const idx = out.lastIndexOf('__ODB_RESULT__');
      if (idx === -1) {
        const oom = /heap out of memory|Allocation failed/i.test(err);
        return finish({ status: 500, headers: {}, body: JSON.stringify({ error: oom ? 'Function ran out of memory' : 'Function crashed' }), logs: [], error: (err || `exit ${code ?? signal}`).slice(0, 4000) });
      }
      try {
        const r = JSON.parse(out.slice(idx + 14).trim());
        if (!r.ok) return finish({ status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Function threw an error', message: String(r.error).split('\n')[0] }), logs: r.logs ?? [], error: r.error });
        finish({ status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? '', logs: r.logs ?? [] });
      } catch (e) {
        finish({ status: 500, headers: {}, body: JSON.stringify({ error: 'Invalid function output' }), logs: [], error: String(e) });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ codeFile, request: fn.request, env: fn.env ?? {} }));
  });
}

function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok', running });
  if (req.method !== 'POST' || req.url !== '/run') return send(res, 404, { error: 'Not Found' });
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
  if (running >= MAX_CONCURRENCY) return send(res, 503, { error: 'Busy' });

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; if (raw.length > 12_000_000) req.destroy(); });
  req.on('end', async () => {
    let fn;
    try {
      fn = JSON.parse(raw);
      if (!fn.project_id || !fn.function_id || typeof fn.code !== 'string') throw new Error('project_id, function_id and code are required');
    } catch (e) {
      return send(res, 400, { error: String(e.message ?? e) });
    }
    running++;
    try {
      const r = await run(fn);
      log(r.error ? 'warn' : 'info', 'invocation', { project_id: fn.project_id, function_id: fn.function_id, status: r.status, ms: r.durationMs });
      send(res, 200, r);
    } catch (e) {
      log('error', 'invocation failed', { err: String(e) });
      send(res, 500, { error: 'Runtime error' });
    } finally {
      running--;
    }
  });
}).listen(PORT, '0.0.0.0', () => log('info', `listening on ${PORT}`, { max_concurrency: MAX_CONCURRENCY }));
