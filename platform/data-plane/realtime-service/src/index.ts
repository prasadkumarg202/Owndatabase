/**
 * OwnDatabase Realtime Service (Phase 5)
 *
 * WebSocket endpoint:  ws(s)://<host>/realtime?project_id=<id>&apikey=<key>[&token=<user access token>]
 *
 * Client → server messages (JSON):
 *   { type: 'subscribe',   channel: 'db:<table>[:insert|update|delete]', filter?: 'col=eq.value', ref? }
 *   { type: 'subscribe',   channel: 'broadcast:<name>' | 'presence:<room>' }
 *   { type: 'unsubscribe', channel }
 *   { type: 'broadcast',   channel: '<name>', event, payload }
 *   { type: 'presence',    action: 'track' | 'untrack', channel: '<room>', payload }
 *   { type: 'access_token', token }        — sign in / refresh on an open socket
 *   { type: 'ping' }
 *
 * Database changes come from a trigger (NOTIFY owndatabase_changes) that the
 * control API installs per table ("Enable realtime"). Every change is checked
 * against Row Level Security as the subscriber before it is delivered.
 *
 * HTTP:  POST /v1/:projectId/broadcast  { channel, event, payload }  (service_role key)
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { collectDefaultMetrics, register, Gauge, Counter } from 'prom-client';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { AuthError, PlatformAuth, type ApiRole, type ProjectInfo } from './lib/platform-auth.js';
import { limitOf } from './lib/limits.js';
import { initTracing, shutdownTracing, tracingPlugin } from './lib/tracing.js';

const PORT = Number(process.env['PORT'] ?? 3004);
const DATABASE_URL = process.env['DATABASE_URL']!;
const REDIS_URL = process.env['REDIS_URL']!;
const JWT_SECRET = process.env['JWT_SECRET']!;
const MAX_SUBS = Number(process.env['REALTIME_MAX_SUBSCRIPTIONS'] ?? 100);
const MAX_MSG_PER_SEC = Number(process.env['REALTIME_MAX_MESSAGES_PER_SECOND'] ?? 50);
for (const [k, v] of Object.entries({ DATABASE_URL, REDIS_URL, JWT_SECRET })) {
  if (!v) { console.error(`${k} is required`); process.exit(1); }
}

const db = postgres(DATABASE_URL, { max: 8, idle_timeout: 30, onnotice: () => {} });
const listenDb = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });   // LISTEN needs a direct session
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const redisAuthSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
[redis, redisSub, redisAuthSub].forEach((r) => r.on('error', () => {}));
const platform = new PlatformAuth(db, JWT_SECRET, redisAuthSub);
const INSTANCE = randomUUID();

collectDefaultMetrics({ prefix: 'owndatabase_realtime_' });
const activeConnections = new Gauge({ name: 'owndatabase_realtime_active_connections', help: 'Open WebSocket connections', labelNames: ['project_id'] });
const subscriptionsActive = new Gauge({ name: 'owndatabase_realtime_subscriptions_active', help: 'Active subscriptions', labelNames: ['project_id'] });
const messagesDelivered = new Counter({ name: 'owndatabase_realtime_messages_delivered_total', help: 'Messages delivered', labelNames: ['project_id', 'kind'] });

// ── Connection registry ─────────────────────────────────────────────────────

interface Sub { channel: string; table?: string; event?: string; filter?: { col: string; op: string; value: string } }

interface Client {
  id: string;
  socket: WebSocket;
  project: ProjectInfo;
  role: ApiRole;
  claims: Record<string, any> | null;
  userId: string | null;
  subs: Map<string, Sub>;
  presence: Map<string, Record<string, unknown>>;
  msgWindow: { second: number; count: number };
}

const clients = new Map<string, Client>();

function send(c: Client, msg: Record<string, unknown>) {
  if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg));
}

// ── Catalog helpers (cached) ────────────────────────────────────────────────

const schemaToProject = new Map<string, { id: string; exp: number }>();
async function projectForSchema(schema: string): Promise<string | null> {
  const hit = schemaToProject.get(schema);
  if (hit && hit.exp > Date.now()) return hit.id;
  const [row] = await db`SELECT id FROM control_plane.projects WHERE db_schema = ${schema}`;
  if (!row) return null;
  schemaToProject.set(schema, { id: row['id'] as string, exp: Date.now() + 60_000 });
  return row['id'] as string;
}

const tableMeta = new Map<string, { pk: string[]; rls: boolean; exp: number }>();
async function getTableMeta(schema: string, table: string) {
  const key = `${schema}.${table}`;
  const hit = tableMeta.get(key);
  if (hit && hit.exp > Date.now()) return hit;
  const [row] = await db`
    SELECT c.relrowsecurity AS rls,
           ARRAY(SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = c.oid AND i.indisprimary)::text[] AS pk
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table}`;
  const meta = { pk: (row?.['pk'] as string[]) ?? [], rls: !!row?.['rls'], exp: Date.now() + 30_000 };
  tableMeta.set(key, meta);
  return meta;
}

const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';

/** Can this role/user SELECT the row now? Runs as the subscriber, so RLS and grants apply. */
async function canSee(schema: string, table: string, pkValues: Record<string, unknown>, role: ApiRole, claims: Record<string, any> | null): Promise<boolean> {
  if (role === 'service_role') return true;
  const meta = await getTableMeta(schema, table);
  if (!meta.pk.length || meta.pk.some((k) => pkValues[k] === undefined)) return false;
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims ?? { role })}, true)`;
      const where = meta.pk.map((k, i) => `${ident(k)}::text = $${i + 1}::text`).join(' AND ');
      const rows = await tx.unsafe(`SELECT 1 FROM ${ident(schema)}.${ident(table)} WHERE ${where} LIMIT 1`, meta.pk.map((k) => String(pkValues[k])));
      return rows.length > 0;
    }) as boolean;
  } catch {
    return false; // no grant / RLS error → not visible
  }
}

function matchesFilter(sub: Sub, record: Record<string, unknown> | null): boolean {
  if (!sub.filter) return true;
  if (!record) return false;
  const actual = record[sub.filter.col];
  const v = sub.filter.value;
  const a = actual === null || actual === undefined ? null : String(actual);
  switch (sub.filter.op) {
    case 'eq': return a === v;
    case 'neq': return a !== v;
    case 'gt': return a !== null && Number(a) > Number(v);
    case 'gte': return a !== null && Number(a) >= Number(v);
    case 'lt': return a !== null && Number(a) < Number(v);
    case 'lte': return a !== null && Number(a) <= Number(v);
    case 'in': return a !== null && v.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim()).includes(a);
    default: return false;
  }
}

// ── Database change fan-out ─────────────────────────────────────────────────

interface Change { table: string; schema: string; action: 'INSERT' | 'UPDATE' | 'DELETE'; record: Record<string, unknown>; old_record?: Record<string, unknown> | null; commit_timestamp?: string; truncated?: boolean }

async function handleChange(change: Change) {
  const projectId = await projectForSchema(change.schema);
  if (!projectId) return;
  const event = change.action.toLowerCase();
  const targets: { c: Client; sub: Sub }[] = [];
  for (const c of clients.values()) {
    if (c.project.id !== projectId) continue;
    for (const sub of c.subs.values()) {
      if (sub.table !== change.table && sub.table !== '*') continue;
      if (sub.event && sub.event !== event && sub.event !== '*') continue;
      if (!matchesFilter(sub, change.action === 'DELETE' ? (change.old_record ?? change.record) : change.record)) continue;
      targets.push({ c, sub });
    }
  }
  if (!targets.length) return;

  const meta = await getTableMeta(change.schema, change.table);
  const visibility = new Map<string, boolean>();
  for (const { c, sub } of targets) {
    let payloadRecord = change.record;
    let oldRecord = change.old_record ?? null;
    if (c.role !== 'service_role') {
      if (change.action === 'DELETE') {
        // The row is gone, so RLS cannot be evaluated: only the primary key is sent
        if (meta.rls) {
          const pkOnly = Object.fromEntries(meta.pk.map((k) => [k, (change.old_record ?? change.record)?.[k]]));
          payloadRecord = pkOnly; oldRecord = pkOnly;
        }
      } else {
        const key = `${c.role}:${c.userId ?? ''}`;
        if (!visibility.has(key)) visibility.set(key, await canSee(change.schema, change.table, change.record, c.role, c.claims));
        if (!visibility.get(key)) continue;
        if (change.action === 'UPDATE' && meta.rls) oldRecord = Object.fromEntries(meta.pk.map((k) => [k, change.old_record?.[k]]));
      }
    }
    send(c, {
      type: 'postgres_changes', channel: sub.channel, event, schema: change.schema, table: change.table,
      record: payloadRecord, old_record: oldRecord, commit_timestamp: change.commit_timestamp ?? new Date().toISOString(),
      ...(change.truncated ? { truncated: true } : {}),
    });
    messagesDelivered.inc({ project_id: projectId, kind: 'db' });
  }
}

async function startListener() {
  for (let attempt = 1; ; attempt++) {
    try {
      await listenDb.listen('owndatabase_changes', (payload) => {
        try { void handleChange(JSON.parse(payload) as Change).catch((err) => server.log.error({ err }, 'change fan-out failed')); }
        catch (err) { server.log.error({ err }, 'Bad NOTIFY payload'); }
      }, () => server.log.info('Listening for database changes'));
      return;
    } catch (err) {
      server.log.warn({ err: (err as Error).message, attempt }, 'LISTEN failed, retrying');
      await new Promise((r) => setTimeout(r, Math.min(attempt * 1000, 10_000)));
    }
  }
}

// ── Broadcast + presence across instances (Redis) ───────────────────────────

void redisSub.subscribe('realtime:broadcast', 'realtime:presence').catch(() => {});
redisSub.on('message', (ch: string, raw: string) => {
  try {
    const m = JSON.parse(raw) as { projectId: string; channel: string; data: Record<string, unknown>; exclude?: string; origin: string };
    if (m.origin === INSTANCE) return;
    deliverLocal(m.projectId, m.channel, m.data, m.exclude);
    void ch;
  } catch { /* ignore */ }
});

function deliverLocal(projectId: string, channel: string, data: Record<string, unknown>, exclude?: string) {
  for (const c of clients.values()) {
    if (c.project.id !== projectId || c.id === exclude || !c.subs.has(channel)) continue;
    send(c, data);
    messagesDelivered.inc({ project_id: projectId, kind: channel.split(':')[0]! });
  }
}

async function publish(projectId: string, channel: string, data: Record<string, unknown>, exclude?: string) {
  deliverLocal(projectId, channel, data, exclude);
  await redis.publish(channel.startsWith('presence:') ? 'realtime:presence' : 'realtime:broadcast',
    JSON.stringify({ projectId, channel, data, exclude, origin: INSTANCE })).catch(() => {});
}

const presenceKey = (projectId: string, room: string) => `rt:presence:${projectId}:${room}`;

async function presenceState(projectId: string, room: string) {
  const all = await redis.hgetall(presenceKey(projectId, room));
  return Object.entries(all).map(([connection_id, v]) => ({ connection_id, ...JSON.parse(v) }));
}

// ── Server ──────────────────────────────────────────────────────────────────

initTracing('realtime-service');
const server = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info', base: { service: 'realtime-service' } }, trustProxy: true });
tracingPlugin(server);
await server.register(cors, { origin: true });
await server.register(websocket, { options: { maxPayload: 256 * 1024 } });

server.get('/health', async () => ({ status: 'ok', service: 'realtime-service', connections: clients.size, timestamp: new Date().toISOString() }));
server.get('/health/ready', async (_req, reply) => {
  const checks: Record<string, string> = {};
  try { await db`SELECT 1`; checks['postgresql'] = 'healthy'; } catch { checks['postgresql'] = 'unhealthy'; }
  try { await redis.ping(); checks['redis'] = 'healthy'; } catch { checks['redis'] = 'unhealthy'; }
  const ok = Object.values(checks).every((v) => v === 'healthy');
  return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks, connections: clients.size });
});
server.get('/metrics', async (_req, reply) => reply.header('Content-Type', register.contentType).send(await register.metrics()));

const statsHandler = async (req: any, reply: any) => {
  const { projectId } = req.params as { projectId: string };
  try {
    const a = await platform.authenticate(projectId, req.headers as any, req.query as any, { allowPlatformUser: true, ip: req.ip });
    if (a.role !== 'service_role') return reply.status(403).send({ error: 'Forbidden' });
  } catch (err) {
    if (err instanceof AuthError) return reply.status(err.statusCode).send({ error: 'Unauthorized', message: err.message });
    throw err;
  }
  const mine = [...clients.values()].filter((c) => c.project.id === projectId);
  const channels: Record<string, number> = {};
  for (const c of mine) for (const ch of c.subs.keys()) channels[ch] = (channels[ch] ?? 0) + 1;
  return reply.send({ connections: mine.length, channels, instance: INSTANCE });
};
// Also reachable as /realtime/v1/... because the gateway forwards the /realtime prefix
server.get('/v1/:projectId/stats', statsHandler);
server.get('/realtime/v1/:projectId/stats', statsHandler);

const broadcastHandler = async (req: any, reply: any) => {
  const { projectId } = req.params as { projectId: string };
  try {
    const a = await platform.authenticate(projectId, req.headers as any, req.query as any, { allowPlatformUser: true, ip: req.ip });
    if (a.role !== 'service_role') return reply.status(403).send({ error: 'Forbidden', message: 'Server-side broadcast needs a service_role key' });
  } catch (err) {
    if (err instanceof AuthError) return reply.status(err.statusCode).send({ error: 'Unauthorized', message: err.message });
    throw err;
  }
  const b = req.body as { channel?: string; event?: string; payload?: Record<string, unknown> };
  if (!b?.channel || !b.event) return reply.status(400).send({ error: 'Bad Request', message: 'channel and event are required' });
  await publish(projectId, `broadcast:${b.channel}`, { type: 'broadcast', channel: b.channel, event: b.event, payload: b.payload ?? {}, sender: 'server', timestamp: new Date().toISOString() });
  return reply.status(202).send({ ok: true });
};
server.post('/v1/:projectId/broadcast', broadcastHandler);
server.post('/realtime/v1/:projectId/broadcast', broadcastHandler);

server.get('/realtime', { websocket: true }, async (conn: any, request) => {
  const socket: WebSocket = conn.socket ?? conn;
  const q = request.query as Record<string, string>;
  const projectId = q['project_id'] ?? '';
  let auth;
  try {
    const headers = { ...request.headers, ...(q['token'] ? { authorization: `Bearer ${q['token']}` } : {}) };
    // Dashboard members may connect with their control-plane token (acts as service_role)
    auth = await platform.authenticate(projectId, headers as any, q, { allowPlatformUser: true, ip: request.ip });
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : 'Authentication failed';
    socket.send(JSON.stringify({ type: 'error', code: 'auth_failed', message: msg }));
    socket.close(4001, msg.slice(0, 100));
    return;
  }

  // realtime_connections limit (counted per realtime instance)
  const maxConn = limitOf(auth.project, 'realtime_connections');
  if (maxConn !== null && [...clients.values()].filter((x) => x.project.id === auth.project.id).length >= maxConn) {
    const msg = `This project has reached its limit of ${maxConn} realtime connections`;
    socket.send(JSON.stringify({ type: 'error', code: 'quota_exceeded', message: msg }));
    socket.close(4029, 'quota exceeded');
    return;
  }

  const c: Client = {
    id: randomUUID(), socket, project: auth.project, role: auth.role, claims: auth.claims, userId: auth.userId,
    subs: new Map(), presence: new Map(), msgWindow: { second: 0, count: 0 },
  };
  clients.set(c.id, c);
  activeConnections.inc({ project_id: projectId });
  send(c, { type: 'connected', connection_id: c.id, project_id: projectId, role: c.role, user_id: c.userId });

  const heartbeat = setInterval(() => { if (socket.readyState === 1) socket.ping(); }, 25_000);

  socket.on('message', async (raw: Buffer) => {
    const sec = Math.floor(Date.now() / 1000);
    if (c.msgWindow.second !== sec) c.msgWindow = { second: sec, count: 0 };
    if (++c.msgWindow.count > MAX_MSG_PER_SEC) return send(c, { type: 'error', code: 'rate_limited', message: 'Too many messages' });
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return send(c, { type: 'error', message: 'Invalid JSON' }); }
    try { await handleMessage(c, msg); }
    catch (err) {
      server.log.error({ err }, 'message handling failed');
      send(c, { type: 'error', ref: msg?.ref, message: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  socket.on('close', () => {
    clearInterval(heartbeat);
    for (const room of c.presence.keys()) {
      void redis.hdel(presenceKey(projectId, room), c.id);
      void publish(projectId, `presence:${room}`, { type: 'presence', event: 'leave', channel: room, connection_id: c.id }, c.id);
    }
    subscriptionsActive.dec({ project_id: projectId }, c.subs.size);
    activeConnections.dec({ project_id: projectId });
    clients.delete(c.id);
  });
  socket.on('error', () => {});
});

async function handleMessage(c: Client, msg: any) {
  const ref = msg?.ref;
  switch (msg?.type) {
    case 'ping':
      return send(c, { type: 'pong', ref });

    case 'access_token': {
      if (!msg.token) {
        c.role = c.role === 'service_role' ? 'service_role' : 'anon'; c.claims = { role: c.role }; c.userId = null;
      } else {
        const claims = await platform.verifyUserToken(String(msg.token), c.project.id).catch(() => null);
        if (!claims) return send(c, { type: 'error', ref, code: 'invalid_token', message: 'Invalid or expired access token' });
        if (c.role !== 'service_role') c.role = 'authenticated';
        c.claims = claims; c.userId = claims['sub'] as string;
      }
      return send(c, { type: 'access_token_updated', ref, role: c.role, user_id: c.userId });
    }

    case 'subscribe': {
      const channel = String(msg.channel ?? '');
      if (c.subs.size >= MAX_SUBS) return send(c, { type: 'error', ref, message: `Subscription limit (${MAX_SUBS}) reached` });
      if (msg.token) await handleMessage(c, { type: 'access_token', token: msg.token });

      let sub: Sub;
      if (channel.startsWith('db:')) {
        const [, table, event] = channel.split(':');
        if (!table || !/^([A-Za-z_][A-Za-z0-9_]*|\*)$/.test(table)) return send(c, { type: 'error', ref, message: 'Invalid table in channel' });
        if (event && !['insert', 'update', 'delete', '*'].includes(event)) return send(c, { type: 'error', ref, message: 'Event must be insert, update, delete or *' });
        sub = { channel, table, event };
        if (msg.filter) {
          const m = String(msg.filter).match(/^([A-Za-z_][A-Za-z0-9_]*)=(eq|neq|gt|gte|lt|lte|in)\.(.*)$/);
          if (!m) return send(c, { type: 'error', ref, message: 'Invalid filter. Use col=eq.value' });
          sub.filter = { col: m[1]!, op: m[2]!, value: m[3]! };
          sub.channel = `${channel}|${msg.filter}`;
        }
        if (table !== '*') {
          const [exists] = await db`SELECT 1 FROM pg_tables WHERE schemaname = ${c.project.db_schema} AND tablename = ${table}`;
          if (!exists) return send(c, { type: 'error', ref, message: `Table '${table}' not found` });
          const [trig] = await db`
            SELECT 1 FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE n.nspname = ${c.project.db_schema} AND cl.relname = ${table} AND t.tgname LIKE 'owndatabase_realtime_%'`;
          if (!trig) send(c, { type: 'warning', ref, message: `Realtime is not enabled for '${table}'. Enable it in the dashboard (Database → Tables).` });
        }
      } else if (channel.startsWith('broadcast:') || channel.startsWith('presence:')) {
        const name = channel.split(':').slice(1).join(':');
        if (!name || name.length > 200) return send(c, { type: 'error', ref, message: 'Invalid channel name' });
        if (name.startsWith('private-') && c.role === 'anon') return send(c, { type: 'error', ref, message: 'Private channels need a signed-in user' });
        sub = { channel };
      } else {
        return send(c, { type: 'error', ref, message: "Channel must start with 'db:', 'broadcast:' or 'presence:'" });
      }
      if (!c.subs.has(sub.channel)) subscriptionsActive.inc({ project_id: c.project.id });
      c.subs.set(sub.channel, sub);
      send(c, { type: 'subscribed', ref, channel: sub.channel });
      if (channel.startsWith('presence:')) {
        send(c, { type: 'presence', event: 'sync', channel: channel.slice(9), presences: await presenceState(c.project.id, channel.slice(9)) });
      }
      return;
    }

    case 'unsubscribe': {
      const channel = String(msg.channel ?? '');
      if (c.subs.delete(channel)) subscriptionsActive.dec({ project_id: c.project.id });
      return send(c, { type: 'unsubscribed', ref, channel });
    }

    case 'broadcast': {
      const name = String(msg.channel ?? '');
      if (!name || !msg.event) return send(c, { type: 'error', ref, message: 'channel and event are required' });
      if (name.startsWith('private-') && c.role === 'anon') return send(c, { type: 'error', ref, message: 'Private channels need a signed-in user' });
      const payload = JSON.stringify(msg.payload ?? {});
      if (payload.length > 64 * 1024) return send(c, { type: 'error', ref, message: 'Payload too large (64 KB max)' });
      await publish(c.project.id, `broadcast:${name}`, {
        type: 'broadcast', channel: name, event: String(msg.event), payload: msg.payload ?? {},
        sender_id: c.id, user_id: c.userId, timestamp: new Date().toISOString(),
      }, msg.self ? undefined : c.id);
      return ref ? send(c, { type: 'ack', ref }) : undefined;
    }

    case 'presence': {
      const room = String(msg.channel ?? '');
      if (!room) return send(c, { type: 'error', ref, message: 'channel is required' });
      const key = presenceKey(c.project.id, room);
      if (msg.action === 'track') {
        const payload = { ...(msg.payload ?? {}), user_id: c.userId, online_at: new Date().toISOString() };
        c.presence.set(room, payload);
        await redis.hset(key, c.id, JSON.stringify(payload));
        await redis.expire(key, 24 * 3600);
        if (!c.subs.has(`presence:${room}`)) { c.subs.set(`presence:${room}`, { channel: `presence:${room}` }); subscriptionsActive.inc({ project_id: c.project.id }); }
        await publish(c.project.id, `presence:${room}`, { type: 'presence', event: 'join', channel: room, connection_id: c.id, payload }, c.id);
        return send(c, { type: 'presence', event: 'sync', channel: room, ref, presences: await presenceState(c.project.id, room) });
      }
      if (msg.action === 'untrack') {
        c.presence.delete(room);
        await redis.hdel(key, c.id);
        await publish(c.project.id, `presence:${room}`, { type: 'presence', event: 'leave', channel: room, connection_id: c.id }, c.id);
        return send(c, { type: 'presence_untracked', ref, channel: room });
      }
      return send(c, { type: 'error', ref, message: "presence action must be 'track' or 'untrack'" });
    }

    default:
      return send(c, { type: 'error', ref, message: `Unknown message type '${msg?.type}'` });
  }
}

server.setNotFoundHandler((_req, reply) => { void reply.status(404).send({ error: 'Not Found' }); });

try {
  await server.listen({ port: PORT, host: '0.0.0.0' });
  void startListener();
} catch (err) {
  server.log.error(err, 'Failed to start'); process.exit(1);
}

const shutdown = async () => {
  for (const c of clients.values()) {
    send(c, { type: 'system', code: 'SHUTDOWN', message: 'Server shutting down' });
    c.socket.close(1001, 'Server shutdown');
    for (const room of c.presence.keys()) await redis.hdel(presenceKey(c.project.id, room), c.id).catch(() => {});
  }
  await server.close();
  await Promise.all([db.end({ timeout: 3 }), listenDb.end({ timeout: 3 })]);
  [redis, redisSub, redisAuthSub].forEach((r) => r.disconnect());
  await shutdownTracing(); process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
