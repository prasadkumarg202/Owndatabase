/**
 * Realtime over one WebSocket (OwnDatabase protocol, see realtime-service):
 *
 *   const ch = db.channel('orders-feed')
 *     .on('postgres_changes', { event: 'INSERT', table: 'orders', filter: 'status=eq.paid' }, (msg) => …)
 *     .on('broadcast', { event: 'typing' }, (msg) => …)
 *     .on('presence', { event: 'sync' }, (msg) => …)
 *     .subscribe((status) => …);                       // 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'CLOSED'
 *   ch.send({ type: 'broadcast', event: 'typing', payload: { user: 'a' } });
 *   ch.track({ online_at: Date.now() });
 *   db.removeChannel(ch);
 *
 * The socket reconnects with backoff and re-subscribes; the signed-in user's
 * token is sent on connect and after every refresh.
 */
import type { ClientContext } from './types.js';

type Handler = (msg: any) => void;
type Status = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'CLOSED' | 'TIMED_OUT';
interface Binding { kind: 'postgres_changes' | 'broadcast' | 'presence'; filter: Record<string, string | undefined>; cb: Handler }

export class RealtimeChannel {
  private bindings: Binding[] = [];
  private statusCb: ((s: Status, err?: Error) => void) | null = null;
  /** server channel names this channel subscribed to */
  wire: string[] = [];

  constructor(private rt: RealtimeClient, public readonly topic: string) {}

  on(kind: 'postgres_changes', filter: { event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*'; schema?: string; table: string; filter?: string }, cb: Handler): this;
  on(kind: 'broadcast', filter: { event?: string }, cb: Handler): this;
  on(kind: 'presence', filter: { event?: 'sync' | 'join' | 'leave' }, cb: Handler): this;
  on(kind: Binding['kind'], filter: Record<string, string | undefined>, cb: Handler): this {
    this.bindings.push({ kind, filter, cb });
    return this;
  }

  subscribe(cb?: (s: Status, err?: Error) => void): this {
    this.statusCb = cb ?? null;
    this.wire = [];
    const msgs: any[] = [];
    for (const b of this.bindings) {
      if (b.kind === 'postgres_changes') {
        const ev = (b.filter['event'] ?? '*').toLowerCase();
        const channel = `db:${b.filter['table']}${ev === '*' ? '' : `:${ev}`}`;
        this.wire.push(channel);
        msgs.push({ type: 'subscribe', channel, ...(b.filter['filter'] ? { filter: b.filter['filter'] } : {}) });
      }
    }
    if (this.bindings.some((b) => b.kind === 'broadcast')) { this.wire.push(`broadcast:${this.topic}`); msgs.push({ type: 'subscribe', channel: `broadcast:${this.topic}` }); }
    if (this.bindings.some((b) => b.kind === 'presence')) { this.wire.push(`presence:${this.topic}`); msgs.push({ type: 'subscribe', channel: `presence:${this.topic}` }); }
    this.rt.join(this, msgs);
    return this;
  }

  /** @internal */
  status(s: Status, err?: Error) { this.statusCb?.(s, err); }

  /** @internal */
  deliver(msg: any) {
    for (const b of this.bindings) {
      if (msg.type === 'postgres_changes' && b.kind === 'postgres_changes') {
        const ev = (b.filter['event'] ?? '*').toUpperCase();
        if (msg.table === b.filter['table'] && (ev === '*' || ev === msg.event?.toUpperCase())) {
          b.cb({ eventType: String(msg.event).toUpperCase(), schema: msg.schema, table: msg.table, new: msg.record ?? {}, old: msg.old_record ?? {}, commit_timestamp: msg.commit_timestamp });
        }
      } else if (msg.type === 'broadcast' && b.kind === 'broadcast' && msg.channel === this.topic) {
        if (!b.filter['event'] || b.filter['event'] === msg.event) b.cb({ event: msg.event, payload: msg.payload, sender: msg.sender });
      } else if (msg.type === 'presence' && b.kind === 'presence' && msg.channel === this.topic) {
        if (!b.filter['event'] || b.filter['event'] === msg.event) b.cb(msg);
      }
    }
  }

  send(msg: { type: 'broadcast'; event: string; payload?: unknown }) {
    return this.rt.send({ type: 'broadcast', channel: this.topic, event: msg.event, payload: msg.payload ?? {} });
  }

  track(payload: Record<string, unknown>) { return this.rt.send({ type: 'presence', action: 'track', channel: this.topic, payload }); }
  untrack() { return this.rt.send({ type: 'presence', action: 'untrack', channel: this.topic }); }
  unsubscribe() { this.rt.leave(this); }
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private channels = new Set<RealtimeChannel>();
  private queue: string[] = [];
  private attempts = 0;
  private closedByUser = false;
  private pending = new Map<string, RealtimeChannel>();   // subscribe ref → channel
  private refSeq = 0;
  private ready = false;
  private connecting = false;

  constructor(private ctx: ClientContext, private token: () => Promise<string | null>, private WS: typeof WebSocket | undefined) {}

  channel(topic: string) { return new RealtimeChannel(this, topic); }
  getChannels() { return [...this.channels]; }

  /** @internal */
  join(ch: RealtimeChannel, msgs: any[]) {
    this.channels.add(ch);
    for (const m of msgs) {
      const ref = `r${++this.refSeq}`;
      this.pending.set(ref, ch);
      this.send({ ...m, ref });
    }
  }

  /** @internal */
  leave(ch: RealtimeChannel) {
    this.channels.delete(ch);
    for (const w of ch.wire) {
      const stillUsed = [...this.channels].some((c) => c.wire.includes(w));
      if (!stillUsed) this.send({ type: 'unsubscribe', channel: w });
    }
    ch.status('CLOSED');
    if (!this.channels.size) this.disconnect();
  }

  send(msg: object): boolean {
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === 1 && this.ready) { this.ws.send(text); return true; }
    this.queue.push(text);
    void this.connect();
    return false;
  }

  /** Re-sends the user's token on the open socket (after sign-in / refresh). */
  async setAuth(token: string | null) { if (token && this.ws?.readyState === 1 && this.ready) this.ws.send(JSON.stringify({ type: 'access_token', token })); }

  private async connect() {
    if (this.connecting || (this.ws && this.ws.readyState <= 1)) return;
    this.connecting = true;
    const WS = this.WS ?? (globalThis as any).WebSocket;
    if (!WS) throw new Error('No WebSocket implementation: pass options.realtime.WebSocket (e.g. from the "ws" package) on Node < 22');
    this.closedByUser = false;
    const token = await this.token().finally(() => { this.connecting = false; });
    this.ready = false;
    const url = `${this.ctx.urls.realtime}${this.ctx.urls.realtime.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(this.ctx.apiKey)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const ws: WebSocket = new WS(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      // the server authenticates first and only then reads messages: flush on 'connected', not on open
      if (msg.type === 'connected') {
        this.ready = true;
        this.attempts = 0;
        const q = this.queue; this.queue = [];
        for (const t of q) ws.send(t);
        return;
      }
      if (msg.type === 'error' && !msg.ref && (msg.code === 'auth_failed' || msg.code === 'quota_exceeded')) {
        for (const ch of this.channels) ch.status('CHANNEL_ERROR', new Error(msg.message));
        return;
      }
      if (msg.type === 'subscribed' || (msg.type === 'error' && msg.ref)) {
        const ch = this.pending.get(msg.ref);
        this.pending.delete(msg.ref);
        if (ch) ch.status(msg.type === 'subscribed' ? 'SUBSCRIBED' : 'CHANNEL_ERROR', msg.type === 'error' ? new Error(msg.message) : undefined);
        return;
      }
      for (const ch of this.channels) ch.deliver(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.ready = false;
      if (this.closedByUser || !this.channels.size) return;
      // reconnect and re-subscribe everything
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++);
      setTimeout(() => { for (const ch of this.channels) ch.subscribe(); }, delay);
    };
  }

  disconnect() {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}
