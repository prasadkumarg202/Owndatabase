/**
 * @owndatabase/client
 *
 *   import { createClient } from '@owndatabase/client';
 *
 *   // platform URL + project id …
 *   const db = createClient('https://db.example.com', ANON_KEY, { projectId: 'b6f1…' });
 *   // … or a custom domain (docs/custom-domains.md)
 *   const db = createClient('https://api.myapp.com', ANON_KEY);
 *
 *   await db.auth.signInWithPassword({ email, password });
 *   const { data, error } = await db.from('orders').select('id,total').eq('status', 'paid');
 *   await db.storage.from('avatars').upload('me.png', file);
 *   await db.functions.invoke('send-invoice', { body: { id: 1 } });
 *   db.channel('orders').on('postgres_changes', { event: 'INSERT', table: 'orders' }, console.log).subscribe();
 */
import { AuthClient, type StorageLike } from './auth.js';
import { QueryBuilder } from './query.js';
import { RealtimeClient } from './realtime.js';
import { StorageClient } from './storage.js';
import { request, type ClientContext, type Fetch, type OdbResponse } from './types.js';

export type { OdbError, OdbResponse } from './types.js';
export type { Session, User, AuthEvent } from './auth.js';
export type { RealtimeChannel } from './realtime.js';

export interface ClientOptions {
  /** Needed with the platform URL; leave out with a custom domain. */
  projectId?: string;
  auth?: { persistSession?: boolean; autoRefreshToken?: boolean; storageKey?: string; storage?: StorageLike };
  global?: { fetch?: Fetch; headers?: Record<string, string> };
  realtime?: { WebSocket?: typeof WebSocket };
}

export class OwnDatabaseClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;
  readonly functions: { invoke: <T = any>(slug: string, opts?: { body?: unknown; headers?: Record<string, string>; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }) => Promise<OdbResponse<T>> };
  readonly realtime: RealtimeClient;
  private ctx: ClientContext;

  constructor(url: string, apiKey: string, opts: ClientOptions = {}) {
    if (!url || !apiKey) throw new Error('createClient(url, apiKey) needs both arguments');
    const base = url.replace(/\/+$/, '');
    const p = opts.projectId ? `/${opts.projectId}` : '';
    const wsBase = base.replace(/^http/, 'ws');
    let auth: AuthClient;
    this.ctx = {
      urls: {
        rest: `${base}/rest/v1${p}`, auth: `${base}/auth/v1${p}`, storage: `${base}/storage/v1${p}`,
        functions: `${base}/functions/v1${p}`, realtime: `${wsBase}/realtime${opts.projectId ? `?project_id=${opts.projectId}` : ''}`,
      },
      apiKey,
      fetch: opts.global?.fetch ?? globalThis.fetch.bind(globalThis),
      headers: { 'x-client-info': 'owndatabase-js/0.1.0', ...(opts.global?.headers ?? {}) },
      bearer: async () => (await auth.accessToken()) ?? apiKey,
    };
    auth = new AuthClient(this.ctx, {
      storageKey: opts.auth?.storageKey ?? `odb-auth-${opts.projectId ?? new URL(base).host}`,
      persistSession: opts.auth?.persistSession ?? true,
      autoRefreshToken: opts.auth?.autoRefreshToken ?? true,
      storage: opts.auth?.storage,
    });
    this.auth = auth;
    this.storage = new StorageClient(this.ctx);
    this.realtime = new RealtimeClient(this.ctx, () => auth.accessToken(), opts.realtime?.WebSocket);
    auth.onAuthStateChange((event, session) => { if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') void this.realtime.setAuth(session?.access_token ?? null); });
    this.functions = {
      invoke: async (slug, o = {}) => request(this.ctx, `${this.ctx.urls.functions}/${encodeURIComponent(slug)}`, {
        method: o.method ?? 'POST', headers: o.headers,
        ...(o.body === undefined ? {} : typeof o.body === 'string' ? { body: o.body } : { json: o.body }),
      }),
    };
  }

  /** Query a table or view. */
  from<T = any>(table: string) { return new QueryBuilder<T>(this.ctx, table); }

  /** Call a database function (POST /rpc/<fn>). */
  rpc<T = any>(fn: string, args: Record<string, unknown> = {}, opts: { get?: boolean } = {}): Promise<OdbResponse<T>> {
    if (opts.get) {
      const q = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]));
      return request(this.ctx, `${this.ctx.urls.rest}/rpc/${encodeURIComponent(fn)}?${q}`);
    }
    return request(this.ctx, `${this.ctx.urls.rest}/rpc/${encodeURIComponent(fn)}`, { method: 'POST', json: args });
  }

  /** GraphQL over the project schema (docs/graphql.md). GraphQL errors come back in `error`. */
  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<OdbResponse<T>> {
    const base = this.ctx.urls.rest.replace(/\/rest\/v1(\/[^/]+)?$/, (_m, pid: string | undefined) => `/graphql/v1${pid ?? ''}`);
    const r = await request<any>(this.ctx, base, { method: 'POST', json: { query, variables } });
    const errs = r.data?.errors as { message: string }[] | undefined;
    if (r.error || errs?.length) {
      return { data: r.data?.data ?? null, status: r.status, error: r.error ?? { status: r.status, message: errs!.map((e) => e.message).join('; '), details: errs } };
    }
    return { data: r.data.data, error: null, status: r.status };
  }

  channel(topic: string) { return this.realtime.channel(topic); }
  removeChannel(ch: ReturnType<RealtimeClient['channel']>) { ch.unsubscribe(); }
  removeAllChannels() { for (const ch of this.realtime.getChannels()) ch.unsubscribe(); }
}

export function createClient(url: string, apiKey: string, opts: ClientOptions = {}) {
  return new OwnDatabaseClient(url, apiKey, opts);
}
