/**
 * PostgREST-style query builder:
 *   db.from('orders').select('id,total,customer:customers(name)').eq('status', 'paid').order('id', { ascending: false }).limit(10)
 * Builders are thenable: `const { data, error } = await …`.
 */
import { request, type ClientContext, type OdbResponse } from './types.js';

type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE';
type Count = 'exact' | 'planned' | 'estimated';

const fmt = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? `(${v.map((x) => (/[,()]/.test(String(x)) ? `"${String(x)}"` : String(x))).join(',')})` : String(v));

export class QueryBuilder<T = any> implements PromiseLike<OdbResponse<T>> {
  private params = new URLSearchParams();
  private method: Method = 'GET';
  private body: unknown = undefined;
  private prefer: string[] = [];
  private wantOne: 'one' | 'maybe' | null = null;
  private countMode: Count | null = null;

  constructor(private ctx: ClientContext, private table: string) {}

  // ── verbs ──────────────────────────────────────────────────────────────────
  select(columns = '*', opts: { count?: Count; head?: boolean } = {}): this {
    if (this.method === 'GET' || this.method === 'HEAD') this.method = opts.head ? 'HEAD' : 'GET';
    else this.prefer.push('return=representation');
    this.params.set('select', columns.replace(/\s+/g, ''));
    if (opts.count) { this.countMode = opts.count; this.prefer.push(`count=${opts.count}`); }
    return this;
  }

  insert(values: Partial<T> | Partial<T>[], opts: { count?: Count; defaultToNull?: boolean } = {}): this {
    this.method = 'POST'; this.body = values;
    if (opts.count) this.prefer.push(`count=${opts.count}`);
    return this;
  }

  upsert(values: Partial<T> | Partial<T>[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.method = 'POST'; this.body = values;
    this.prefer.push(`resolution=${opts.ignoreDuplicates ? 'ignore' : 'merge'}-duplicates`);
    if (opts.onConflict) this.params.set('on_conflict', opts.onConflict);
    return this;
  }

  update(values: Partial<T>): this { this.method = 'PATCH'; this.body = values; return this; }
  delete(): this { this.method = 'DELETE'; return this; }

  // ── filters ────────────────────────────────────────────────────────────────
  private op(col: string, op: string, v: unknown): this { this.params.append(col, `${op}.${fmt(v)}`); return this; }
  eq(col: string, v: unknown) { return this.op(col, 'eq', v); }
  neq(col: string, v: unknown) { return this.op(col, 'neq', v); }
  gt(col: string, v: unknown) { return this.op(col, 'gt', v); }
  gte(col: string, v: unknown) { return this.op(col, 'gte', v); }
  lt(col: string, v: unknown) { return this.op(col, 'lt', v); }
  lte(col: string, v: unknown) { return this.op(col, 'lte', v); }
  like(col: string, pattern: string) { return this.op(col, 'like', pattern); }
  ilike(col: string, pattern: string) { return this.op(col, 'ilike', pattern); }
  is(col: string, v: null | boolean) { return this.op(col, 'is', v); }
  in(col: string, values: unknown[]) { return this.op(col, 'in', values); }
  contains(col: string, v: unknown) { return this.op(col, 'cs', Array.isArray(v) ? `{${v.join(',')}}` : JSON.stringify(v)); }
  not(col: string, op: string, v: unknown) { return this.op(col, `not.${op}`, v); }
  or(expr: string) { this.params.append('or', `(${expr})`); return this; }
  match(query: Record<string, unknown>) { for (const [k, v] of Object.entries(query)) this.eq(k, v); return this; }
  filter(col: string, op: string, v: unknown) { return this.op(col, op, v); }

  // ── modifiers ──────────────────────────────────────────────────────────────
  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    const part = `${col}.${opts.ascending === false ? 'desc' : 'asc'}${opts.nullsFirst === undefined ? '' : opts.nullsFirst ? '.nullsfirst' : '.nullslast'}`;
    const cur = this.params.get('order');
    this.params.set('order', cur ? `${cur},${part}` : part);
    return this;
  }
  limit(n: number) { this.params.set('limit', String(n)); return this; }
  range(from: number, to: number) { this.params.set('offset', String(from)); this.params.set('limit', String(to - from + 1)); return this; }
  /** Exactly one row, else an error (406). */
  single() { this.wantOne = 'one'; return this; }
  /** Zero or one row: `data` is null when nothing matched. */
  maybeSingle() { this.wantOne = 'maybe'; return this; }

  // ── execution ──────────────────────────────────────────────────────────────
  then<R1 = OdbResponse<T>, R2 = never>(ok?: ((v: OdbResponse<T>) => R1 | PromiseLike<R1>) | null, fail?: ((e: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
    return this.execute().then(ok, fail);
  }

  private async execute(): Promise<OdbResponse<T>> {
    if (this.method !== 'GET' && this.method !== 'HEAD' && !this.prefer.some((p) => p.startsWith('return='))) this.prefer.push('return=representation');
    const headers: Record<string, string> = {};
    if (this.prefer.length) headers['prefer'] = [...new Set(this.prefer)].join(',');
    const qs = this.params.toString();
    const res = await request<any>(this.ctx, `${this.ctx.urls.rest}/${encodeURIComponent(this.table)}${qs ? `?${qs}` : ''}`, {
      method: this.method, headers, ...(this.body !== undefined ? { json: this.body } : {}),
    });
    // with count: 'exact' | 'planned' | 'estimated', the total is in Content-Range: 0-9/123
    const total = this.countMode ? /\/(\d+)$/.exec(res.range ?? '')?.[1] : undefined;
    const count = total === undefined ? null : Number(total);
    if (res.error) return { data: null, error: res.error, status: res.status, count };
    let data = res.data;
    if (this.wantOne) {
      const rows = Array.isArray(data) ? data : data === null ? [] : [data];
      if (rows.length > 1 || (rows.length === 0 && this.wantOne === 'one')) {
        return { data: null, status: 406, count, error: { status: 406, code: 'PGRST116', message: `JSON object requested, ${rows.length} rows returned` } };
      }
      data = rows[0] ?? null;
    }
    return { data: this.method === 'HEAD' ? null : data, error: null, status: res.status, count };
  }
}
