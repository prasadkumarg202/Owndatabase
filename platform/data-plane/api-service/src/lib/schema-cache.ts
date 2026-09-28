/**
 * Per-project schema introspection with an in-memory cache.
 * Invalidated by `odb:schema-changed` messages from the control plane.
 */
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { db } from './db.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
export const redisSub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', () => {});
redisSub.on('error', () => {});

export interface ColumnInfo {
  name: string;
  type: string;          // format_type() output, safe to use in casts
  udt: string;           // base type name (int8, text, jsonb, …)
  nullable: boolean;
  has_default: boolean;
  is_pk: boolean;
  is_identity_always: boolean;
  is_generated: boolean;
}

export interface Relation {
  name: string;            // constraint name
  from_table: string; from_columns: string[];
  to_table: string; to_columns: string[];
}

export interface TableInfo {
  name: string;
  kind: 'table' | 'view';
  columns: ColumnInfo[];
  columnMap: Map<string, ColumnInfo>;
  pk: string[];
  comment: string | null;
}

export interface FunctionInfo {
  name: string;
  args: { name: string; type: string; has_default: boolean }[];
  returns: string;
  returns_set: boolean;
  volatility: string;
}

export interface SchemaInfo {
  schema: string;
  tables: Map<string, TableInfo>;
  relations: Relation[];
  functions: Map<string, FunctionInfo>;
  loadedAt: number;
}

const TTL = 60_000;
const cache = new Map<string, SchemaInfo>();

void redisSub.subscribe('odb:schema-changed').catch(() => {});
redisSub.on('message', (_ch: string, msg: string) => {
  try {
    const { projectId } = JSON.parse(msg);
    for (const k of cache.keys()) if (k.startsWith(`${projectId}:`)) cache.delete(k);
  } catch { cache.clear(); }
});

export function invalidateSchema(projectId: string) {
  for (const k of cache.keys()) if (k.startsWith(`${projectId}:`)) cache.delete(k);
}

export async function getSchema(projectId: string, schema: string): Promise<SchemaInfo> {
  const key = `${projectId}:${schema}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.loadedAt < TTL) return hit;

  const cols = await db`
    SELECT c.relname AS table, c.relkind, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
           t.typname AS udt, NOT a.attnotnull AS nullable, a.atthasdef AS has_default,
           a.attidentity = 'a' AS identity_always, a.attgenerated <> '' AS generated,
           COALESCE(a.attnum = ANY(i.indkey), false) AS is_pk, obj_description(c.oid) AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
    WHERE n.nspname = ${schema} AND c.relkind IN ('r','p','v','m')
    ORDER BY c.relname, a.attnum`;

  const tables = new Map<string, TableInfo>();
  for (const r of cols) {
    let t = tables.get(r['table'] as string);
    if (!t) {
      t = { name: r['table'] as string, kind: ['v', 'm'].includes(r['relkind'] as string) ? 'view' : 'table', columns: [], columnMap: new Map(), pk: [], comment: r['comment'] as string | null };
      tables.set(t.name, t);
    }
    const col: ColumnInfo = {
      name: r['name'] as string, type: r['type'] as string, udt: r['udt'] as string,
      nullable: r['nullable'] as boolean, has_default: r['has_default'] as boolean, is_pk: r['is_pk'] as boolean,
      is_identity_always: r['identity_always'] as boolean, is_generated: r['generated'] as boolean,
    };
    t.columns.push(col);
    t.columnMap.set(col.name, col);
    if (col.is_pk) t.pk.push(col.name);
  }

  const fks = await db`
    SELECT con.conname AS name, c.relname AS from_table, fc.relname AS to_table,
           ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.ord)::text[] AS from_columns,
           ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.ord)::text[] AS to_columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE con.contype = 'f' AND n.nspname = ${schema} AND fn.nspname = ${schema}`;

  const fns = await db`
    SELECT p.proname AS name, pg_get_function_result(p.oid) AS returns, p.proretset AS returns_set,
           CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
           COALESCE(p.proargnames, '{}')::text[] AS arg_names,
           ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t)::text[] AS arg_types,
           p.pronargdefaults AS n_defaults, p.pronargs AS n_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ${schema} AND p.prokind = 'f'`;

  const functions = new Map<string, FunctionInfo>();
  for (const f of fns) {
    const names = f['arg_names'] as string[];
    const types = f['arg_types'] as string[];
    const nArgs = f['n_args'] as number;
    const nDef = f['n_defaults'] as number;
    functions.set(f['name'] as string, {
      name: f['name'] as string,
      returns: f['returns'] as string,
      returns_set: f['returns_set'] as boolean,
      volatility: f['volatility'] as string,
      args: types.map((type, i) => ({ name: names[i] ?? `$${i + 1}`, type, has_default: i >= nArgs - nDef })),
    });
  }

  const info: SchemaInfo = {
    schema, tables, functions,
    relations: fks.map((f) => ({
      name: f['name'] as string, from_table: f['from_table'] as string, to_table: f['to_table'] as string,
      from_columns: f['from_columns'] as string[], to_columns: f['to_columns'] as string[],
    })),
    loadedAt: Date.now(),
  };
  cache.set(key, info);
  return info;
}
