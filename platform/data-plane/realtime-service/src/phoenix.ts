/**
 * Supabase Realtime protocol (Phoenix channels; serializer vsn 1.0.0 objects or 2.0.0 arrays + binary broadcast) on
 * /realtime/v1/websocket, so supabase-js `channel()` code works unchanged:
 *
 *   supabase.channel('room1')
 *     .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, cb)
 *     .on('broadcast', { event: 'cursor' }, cb)
 *     .on('presence', { event: 'sync' }, cb)
 *     .subscribe()
 *
 * Messages are { topic, event, payload, ref, join_ref }. Topics are "realtime:<name>"
 * (plus "phoenix" for heartbeats). It shares the service's machinery: database
 * changes (checked against RLS for each subscriber), broadcast and presence
 * (Redis fan-out across instances). The schema "public" means the project's schema.
 */
import type postgres from 'postgres';
import type { Redis } from 'ioredis';

export interface PhxBinding { id: number; event: string; schema: string; table: string; filter?: string; internal: string }
export interface PhxChannel {
  topic: string; name: string; joinRef: string | null; bindings: PhxBinding[];
  broadcastSelf: boolean; broadcastAck: boolean; presenceKey: string; tracked: boolean; isPrivate: boolean;
}
export interface PhoenixState { channels: Map<string, PhxChannel>; nextBindingId: number; vsn: '1.0.0' | '2.0.0' }

/** The parts of a realtime client the protocol needs (see index.ts Client). */
export interface PhxClient {
  id: string;
  socket: { readyState: number; send(data: string): void };
  project: { id: string; db_schema: string };
  role: string; claims: Record<string, any> | null; userId: string | null;
  subs: Map<string, { channel: string; table?: string; event?: string; filter?: { col: string; op: string; value: string } }>;
  presence: Map<string, Record<string, unknown>>;
  phoenix?: PhoenixState;
}

export interface PhxDeps {
  db: postgres.Sql<any>;
  redis: Redis;
  publish: (projectId: string, channel: string, data: Record<string, unknown>, exclude?: string) => Promise<void>;
  presenceKey: (projectId: string, room: string) => string;
  verifyUserToken: (token: string, projectId: string) => Promise<Record<string, any> | null>;
  onSubsChanged: (projectId: string, delta: number) => void;
  maxSubs: number;
}

const out = (c: PhxClient, topic: string, event: string, payload: unknown, ref: string | null = null, joinRef: string | null = null) => {
  if (c.socket.readyState !== 1) return;
  c.socket.send(c.phoenix?.vsn === '2.0.0'
    ? JSON.stringify([joinRef, ref, topic, event, payload])
    : JSON.stringify({ topic, event, payload, ref, join_ref: joinRef }));
};

/**
 * Decodes one frame. vsn 2.0.0: text = [join_ref, ref, topic, event, payload];
 * binary kind 3 = a user broadcast push (supabase-js channel.send()).
 */
export function phoenixDecode(raw: Buffer, isBinary: boolean): any {
  if (!isBinary) {
    const v = JSON.parse(raw.toString('utf8'));
    return Array.isArray(v) ? { join_ref: v[0], ref: v[1], topic: v[2], event: v[3], payload: v[4] } : v;
  }
  if (raw[0] !== 3) throw new Error(`Unsupported binary message kind ${raw[0]}`);
  const [joinRefLen, refLen, topicLen, eventLen, metaLen, encoding] = [raw[1]!, raw[2]!, raw[3]!, raw[4]!, raw[5]!, raw[6]!];
  let o = 7;
  const take = (n: number) => { const b = raw.subarray(o, o + n); o += n; return b.toString('utf8'); };
  const joinRef = take(joinRefLen), ref = take(refLen), topic = take(topicLen), userEvent = take(eventLen), meta = take(metaLen);
  if (encoding !== 1) throw new Error('Binary broadcast payloads are not supported; send JSON');
  const payload = JSON.parse(raw.subarray(o).toString('utf8') || '{}');
  return {
    join_ref: joinRef || null, ref: ref || null, topic, event: 'broadcast',
    payload: { type: 'broadcast', event: userEvent, payload, ...(meta ? { meta: JSON.parse(meta) } : {}) },
  };
}
const reply = (c: PhxClient, msg: any, status: 'ok' | 'error', response: Record<string, unknown> = {}) =>
  out(c, msg.topic, 'phx_reply', { status, response }, msg.ref ?? null, msg.join_ref ?? null);

// column types for supabase-js's value conversion (cached)
const columnCache = new Map<string, { cols: { name: string; type: string }[]; exp: number }>();
async function columnsOf(db: postgres.Sql<any>, schema: string, table: string) {
  const key = `${schema}.${table}`;
  const hit = columnCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.cols;
  const rows = await db`
    SELECT a.attname AS name, t.typname AS type FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = ${schema} AND c.relname = ${table} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  const cols = rows.map((r) => ({ name: r['name'] as string, type: r['type'] as string }));
  columnCache.set(key, { cols, exp: Date.now() + 30_000 });
  return cols;
}

/** Internal event (as sent to native clients) → Supabase protocol messages. */
export function phoenixDeliver(c: PhxClient, msg: Record<string, any>, deps: PhxDeps) {
  const st = c.phoenix!;
  if (msg['type'] === 'postgres_changes') {
    for (const ch of st.channels.values()) {
      const matching = ch.bindings.filter((b) => b.internal === msg['channel']);
      if (!matching.length) continue;
      void columnsOf(deps.db, msg['schema'], msg['table']).then((columns) => {
        out(c, ch.topic, 'postgres_changes', {
          ids: matching.map((b) => b.id),
          data: {
            schema: matching[0]!.schema === '*' ? 'public' : matching[0]!.schema, table: msg['table'],
            commit_timestamp: msg['commit_timestamp'], type: String(msg['event']).toUpperCase(),
            record: msg['record'] ?? {}, old_record: msg['old_record'] ?? {}, columns, errors: null,
          },
        });
      }).catch(() => {});
    }
  } else if (msg['type'] === 'broadcast') {
    for (const ch of st.channels.values()) {
      if (ch.name === msg['channel']) out(c, ch.topic, 'broadcast', { type: 'broadcast', event: msg['event'], payload: msg['payload'] ?? {} });
    }
  } else if (msg['type'] === 'presence') {
    for (const ch of st.channels.values()) {
      if (ch.name !== msg['channel']) continue;
      const key = String((msg['payload'] as any)?.__key ?? msg['key'] ?? msg['connection_id']);
      const meta = { phx_ref: msg['connection_id'], ...withoutKey(msg['payload'] ?? {}) };
      if (msg['event'] === 'join') out(c, ch.topic, 'presence_diff', { joins: { [key]: { metas: [meta] } }, leaves: {} });
      if (msg['event'] === 'leave') out(c, ch.topic, 'presence_diff', { joins: {}, leaves: { [key]: { metas: [{ phx_ref: msg['connection_id'] }] } } });
    }
  }
  // other internal messages (connected, warnings, …) have no Supabase equivalent
}

const withoutKey = (p: Record<string, unknown>) => { const { __key, ...rest } = p; void __key; return rest; };

async function presenceStateFor(deps: PhxDeps, projectId: string, room: string) {
  const all = await deps.redis.hgetall(deps.presenceKey(projectId, room));
  const state: Record<string, { metas: Record<string, unknown>[] }> = {};
  for (const [connId, raw] of Object.entries(all)) {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const key = String(p['__key'] ?? connId);
    (state[key] ??= { metas: [] }).metas.push({ phx_ref: connId, ...withoutKey(p) });
  }
  return state;
}

function addSub(c: PhxClient, deps: PhxDeps, sub: { channel: string; table?: string; event?: string; filter?: { col: string; op: string; value: string } }) {
  if (!c.subs.has(sub.channel)) deps.onSubsChanged(c.project.id, 1);
  c.subs.set(sub.channel, sub);
}

function dropUnused(c: PhxClient, deps: PhxDeps, internals: string[]) {
  for (const i of internals) {
    const stillUsed = [...c.phoenix!.channels.values()].some((ch) =>
      ch.bindings.some((b) => b.internal === i) || `broadcast:${ch.name}` === i || `presence:${ch.name}` === i);
    if (!stillUsed && c.subs.delete(i)) deps.onSubsChanged(c.project.id, -1);
  }
}

async function setToken(c: PhxClient, deps: PhxDeps, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !token) return true;
  if (token.startsWith('odb_')) return true;           // an API key, not a user token
  const claims = await deps.verifyUserToken(token, c.project.id).catch(() => null);
  if (!claims) return false;
  if (c.role !== 'service_role') c.role = 'authenticated';
  c.claims = claims; c.userId = (claims['sub'] as string) ?? null;
  return true;
}

export async function leaveAllPresence(c: PhxClient, deps: PhxDeps) {
  for (const ch of c.phoenix?.channels.values() ?? []) {
    if (!ch.tracked) continue;
    await deps.redis.hdel(deps.presenceKey(c.project.id, ch.name), c.id).catch(() => {});
    await deps.publish(c.project.id, `presence:${ch.name}`, { type: 'presence', event: 'leave', channel: ch.name, connection_id: c.id, key: ch.presenceKey }, c.id).catch(() => {});
  }
}

export async function phoenixHandle(c: PhxClient, msg: any, deps: PhxDeps) {
  const st = c.phoenix!;
  const topic = String(msg?.topic ?? '');
  const event = String(msg?.event ?? '');

  if (topic === 'phoenix' && event === 'heartbeat') return reply(c, msg, 'ok');
  if (!topic.startsWith('realtime:')) return reply(c, msg, 'error', { reason: 'unknown topic' });
  const name = topic.slice('realtime:'.length);

  if (event === 'phx_join') {
    const cfg = msg.payload?.config ?? {};
    if (!(await setToken(c, deps, msg.payload?.access_token))) return reply(c, msg, 'error', { reason: 'Invalid or expired access token' });
    if (!name || name.length > 200) return reply(c, msg, 'error', { reason: 'Invalid channel name' });
    const isPrivate = !!cfg.private || name.startsWith('private-');
    if (isPrivate && c.role === 'anon') return reply(c, msg, 'error', { reason: 'Private channels need a signed-in user' });
    if (st.channels.has(topic)) { const prev = st.channels.get(topic)!; st.channels.delete(topic); dropUnused(c, deps, prev.bindings.map((b) => b.internal)); }

    const bindings: PhxBinding[] = [];
    const echo: Record<string, unknown>[] = [];
    for (const pc of (Array.isArray(cfg.postgres_changes) ? cfg.postgres_changes : []) as any[]) {
      const ev = String(pc.event ?? '*').toUpperCase();
      if (!['*', 'INSERT', 'UPDATE', 'DELETE'].includes(ev)) return reply(c, msg, 'error', { reason: `Invalid event ${pc.event}` });
      const schema = String(pc.schema ?? 'public');
      if (!['public', '*', c.project.db_schema].includes(schema)) return reply(c, msg, 'error', { reason: `Unknown schema '${schema}' (use 'public')` });
      const table = pc.table ? String(pc.table) : '*';
      if (!/^([A-Za-z_][A-Za-z0-9_]*|\*)$/.test(table)) return reply(c, msg, 'error', { reason: 'Invalid table' });
      if (table !== '*') {
        const [exists] = await deps.db`SELECT 1 FROM pg_tables WHERE schemaname = ${c.project.db_schema} AND tablename = ${table}`;
        if (!exists) return reply(c, msg, 'error', { reason: `Table '${table}' not found` });
      }
      let filter: { col: string; op: string; value: string } | undefined;
      if (pc.filter) {
        const m = String(pc.filter).match(/^([A-Za-z_][A-Za-z0-9_]*)=(eq|neq|gt|gte|lt|lte|in)\.(.*)$/);
        if (!m) return reply(c, msg, 'error', { reason: 'Invalid filter. Use col=eq.value' });
        filter = { col: m[1]!, op: m[2]!, value: m[3]! };
      }
      const internal = `db:${table}:${ev === '*' ? '*' : ev.toLowerCase()}${pc.filter ? `|${pc.filter}` : ''}`;
      const id = st.nextBindingId++;
      bindings.push({ id, event: pc.event ?? '*', schema, table, filter: pc.filter, internal });
      echo.push({ id, event: pc.event ?? '*', schema: pc.schema, table: pc.table, ...(pc.filter !== undefined ? { filter: pc.filter } : {}) });
      addSub(c, deps, { channel: internal, table, event: ev === '*' ? '*' : ev.toLowerCase(), filter });
    }
    if (c.subs.size > deps.maxSubs) return reply(c, msg, 'error', { reason: `Subscription limit (${deps.maxSubs}) reached` });

    const ch: PhxChannel = {
      topic, name, joinRef: msg.join_ref ?? msg.ref ?? null, bindings,
      broadcastSelf: !!cfg.broadcast?.self, broadcastAck: !!cfg.broadcast?.ack,
      presenceKey: String(cfg.presence?.key || c.id), tracked: false, isPrivate,
    };
    st.channels.set(topic, ch);
    addSub(c, deps, { channel: `broadcast:${name}` });
    addSub(c, deps, { channel: `presence:${name}` });
    reply(c, msg, 'ok', { postgres_changes: echo });
    if (bindings.length) out(c, topic, 'system', { channel: name, extension: 'postgres_changes', message: 'Subscribed to PostgreSQL', status: 'ok' }, null, ch.joinRef);
    out(c, topic, 'presence_state', await presenceStateFor(deps, c.project.id, name), null, ch.joinRef);
    return;
  }

  const ch = st.channels.get(topic);
  if (!ch) return reply(c, msg, 'error', { reason: 'Join the channel first' });

  switch (event) {
    case 'phx_leave': {
      if (ch.tracked) {
        await deps.redis.hdel(deps.presenceKey(c.project.id, name), c.id);
        await deps.publish(c.project.id, `presence:${name}`, { type: 'presence', event: 'leave', channel: name, connection_id: c.id, key: ch.presenceKey }, c.id);
      }
      st.channels.delete(topic);
      dropUnused(c, deps, [...ch.bindings.map((b) => b.internal), `broadcast:${name}`, `presence:${name}`]);
      reply(c, msg, 'ok');
      return out(c, topic, 'phx_close', {}, msg.ref ?? null, ch.joinRef);
    }
    case 'access_token':
      if (!(await setToken(c, deps, msg.payload?.access_token))) return reply(c, msg, 'error', { reason: 'Invalid or expired access token' });
      return msg.ref ? reply(c, msg, 'ok') : undefined;
    case 'broadcast': {
      const p = msg.payload ?? {};
      const body = JSON.stringify(p.payload ?? {});
      if (body.length > 64 * 1024) return reply(c, msg, 'error', { reason: 'Payload too large (64 KB max)' });
      await deps.publish(c.project.id, `broadcast:${name}`, {
        type: 'broadcast', channel: name, event: String(p.event ?? ''), payload: p.payload ?? {},
        sender_id: c.id, user_id: c.userId, timestamp: new Date().toISOString(),
      }, ch.broadcastSelf ? undefined : c.id);
      return ch.broadcastAck || msg.ref ? reply(c, msg, 'ok') : undefined;
    }
    case 'presence': {
      const p = msg.payload ?? {};
      const key = deps.presenceKey(c.project.id, name);
      if (p.event === 'track') {
        const payload = { ...(p.payload ?? {}), __key: ch.presenceKey };
        ch.tracked = true;
        c.presence.set(name, payload);
        await deps.redis.hset(key, c.id, JSON.stringify(payload));
        await deps.redis.expire(key, 24 * 3600);
        await deps.publish(c.project.id, `presence:${name}`, { type: 'presence', event: 'join', channel: name, connection_id: c.id, payload });
        return reply(c, msg, 'ok');
      }
      if (p.event === 'untrack') {
        ch.tracked = false;
        c.presence.delete(name);
        await deps.redis.hdel(key, c.id);
        await deps.publish(c.project.id, `presence:${name}`, { type: 'presence', event: 'leave', channel: name, connection_id: c.id, key: ch.presenceKey });
        return reply(c, msg, 'ok');
      }
      return reply(c, msg, 'error', { reason: 'presence event must be track or untrack' });
    }
    default:
      return reply(c, msg, 'error', { reason: `Unknown event '${event}'` });
  }
}
