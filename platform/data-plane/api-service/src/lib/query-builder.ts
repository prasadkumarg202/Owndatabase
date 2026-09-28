/**
 * PostgREST-style query builder.
 *
 * Turns URL query parameters into parameterised SQL. Every identifier is
 * checked against the introspected schema before it is quoted, and every
 * value is sent as a bind parameter (cast to the column's type), so user
 * input never reaches the SQL text.
 *
 * Supported:
 *   select=id,title,author:users(name),comments(*)       (FK embedding, both directions, nested)
 *   col=eq.1  neq gt gte lt lte like ilike match imatch in is cs cd ov fts plfts phfts wfts
 *   not.<op>  or=(a.eq.1,b.gt.2)  and=(...)  data->>key=eq.x
 *   order=col.desc.nullslast,col2   limit  offset  Range: 0-9
 *   cursor=<opaque>  (keyset pagination on a single-column primary key)
 */

import type { ColumnInfo, SchemaInfo, TableInfo } from './schema-cache.js';

export class QueryError extends Error {
  constructor(public statusCode: number, message: string, public hint?: string) { super(message); }
}

export const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";

export class Params {
  values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

export const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'count', 'cursor', 'on_conflict', 'columns', 'single', 'apikey']);

// ── select= parsing ──────────────────────────────────────────────────────────

export type SelectNode =
  | { kind: 'star' }
  | { kind: 'col'; name: string; alias?: string; cast?: string; path?: string[]; pathText?: boolean }
  | { kind: 'embed'; relation: string; hint?: string; alias?: string; inner: boolean; children: SelectNode[] };

function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (depth !== 0) throw new QueryError(400, 'Unbalanced parentheses in select');
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseColRef(expr: string): { name: string; path?: string[]; pathText?: boolean } {
  const m = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)((?:->>?[A-Za-z0-9_]+)*)$/);
  if (!m) throw new QueryError(400, `Invalid column reference '${expr}'`);
  if (!m[2]) return { name: m[1]! };
  const parts = m[2].match(/->>?[A-Za-z0-9_]+/g)!;
  return { name: m[1]!, path: parts.map((p) => p.replace(/^->>?/, '')), pathText: parts[parts.length - 1]!.startsWith('->>') };
}

export function parseSelect(raw: string | undefined): SelectNode[] {
  if (!raw || raw.trim() === '' || raw.trim() === '*') return [{ kind: 'star' }];
  return splitTopLevel(raw).map((item): SelectNode => {
    if (item === '*') return { kind: 'star' };
    let alias: string | undefined;
    let body = item;
    const aliasMatch = item.match(/^([A-Za-z_][A-Za-z0-9_]*):(?!:)(.+)$/s);
    if (aliasMatch) { alias = aliasMatch[1]; body = aliasMatch[2]!.trim(); }

    const embed = body.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:!([A-Za-z_][A-Za-z0-9_]*))?\((.*)\)$/s);
    if (embed) {
      const hint = embed[2];
      return {
        kind: 'embed', relation: embed[1]!, alias,
        inner: hint === 'inner',
        hint: hint && hint !== 'inner' && hint !== 'left' ? hint : undefined,
        children: parseSelect(embed[3]),
      };
    }
    const [colExpr, cast] = body.split('::');
    if (cast !== undefined && !NAME.test(cast)) throw new QueryError(400, `Invalid cast '${cast}'`);
    return { kind: 'col', ...parseColRef(colExpr!.trim()), alias, cast };
  });
}

// ── Select list generation (with embedding) ──────────────────────────────────

function colExpr(alias: string, col: ColumnInfo, path?: string[], pathText?: boolean): string {
  let e = `${alias}.${ident(col.name)}`;
  if (path?.length) {
    path.forEach((p, i) => { e += `${i === path.length - 1 && pathText ? '->>' : '->'}${lit(p)}`; });
  }
  return e;
}

export function getTable(schema: SchemaInfo, name: string): TableInfo {
  const t = schema.tables.get(name);
  if (!t) throw new QueryError(404, `Relation '${name}' does not exist`, 'Create the table in the dashboard, or check the spelling.');
  return t;
}

function getColumn(t: TableInfo, name: string): ColumnInfo {
  const c = t.columnMap.get(name);
  if (!c) throw new QueryError(400, `Column '${name}' does not exist on '${t.name}'`);
  return c;
}

let aliasSeq = 0;
function nextAlias() { aliasSeq = (aliasSeq + 1) % 1_000_000; return `_e${aliasSeq}`; }

export function buildSelectList(schema: SchemaInfo, table: TableInfo, alias: string, nodes: SelectNode[], depth = 0): { list: string; innerJoins: string[] } {
  if (depth > 4) throw new QueryError(400, 'Embedding is limited to 4 levels');
  const parts: string[] = [];
  const innerJoins: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'star') { parts.push(`${alias}.*`); continue; }
    if (n.kind === 'col') {
      const c = getColumn(table, n.name);
      let e = colExpr(alias, c, n.path, n.pathText);
      if (n.cast) e = `(${e})::${n.cast}`;
      const outName = n.alias ?? (n.path?.length ? n.path[n.path.length - 1]! : n.name);
      parts.push(`${e} AS ${ident(outName)}`);
      continue;
    }
    // Embedding
    const target = getTable(schema, n.relation);
    let rels = schema.relations.filter((r) =>
      (r.from_table === table.name && r.to_table === target.name) || (r.from_table === target.name && r.to_table === table.name));
    if (n.hint) rels = rels.filter((r) => r.name === n.hint || r.from_columns.includes(n.hint!));
    if (rels.length === 0) throw new QueryError(400, `No foreign key between '${table.name}' and '${target.name}'`);
    if (rels.length > 1) {
      throw new QueryError(300, `More than one relationship between '${table.name}' and '${target.name}'`, `Disambiguate with ${target.name}!<constraint_name>(...). Options: ${rels.map((r) => r.name).join(', ')}`);
    }
    const r = rels[0]!;
    const ea = nextAlias();
    const inner = buildSelectList(schema, target, ea, n.children, depth + 1);
    // The current table holds the foreign key → many-to-one (object); otherwise one-to-many (array)
    const manyToOne = r.from_table === table.name;
    const outName = n.alias ?? n.relation;
    let join: string;
    let sub: string;
    if (manyToOne) {
      join = r.from_columns.map((fc, i) => `${ea}.${ident(r.to_columns[i]!)} = ${alias}.${ident(fc)}`).join(' AND ');
      sub = `(SELECT row_to_json(${ea}_r) FROM (SELECT ${inner.list} FROM ${ident(schema.schema)}.${ident(target.name)} ${ea} WHERE ${[join, ...inner.innerJoins].join(' AND ')} LIMIT 1) ${ea}_r)`;
    } else {
      join = r.from_columns.map((fc, i) => `${ea}.${ident(fc)} = ${alias}.${ident(r.to_columns[i]!)}`).join(' AND ');
      sub = `COALESCE((SELECT json_agg(${ea}_r) FROM (SELECT ${inner.list} FROM ${ident(schema.schema)}.${ident(target.name)} ${ea} WHERE ${[join, ...inner.innerJoins].join(' AND ')}) ${ea}_r), '[]'::json)`;
    }
    parts.push(`${sub} AS ${ident(outName)}`);
    if (n.inner) {
      innerJoins.push(`EXISTS (SELECT 1 FROM ${ident(schema.schema)}.${ident(target.name)} ${ea} WHERE ${join})`);
    }
  }
  return { list: parts.join(', ') || `${alias}.*`, innerJoins };
}

// ── Filters ──────────────────────────────────────────────────────────────────

const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function parseList(v: string): string[] {
  const inner = v.startsWith('(') && v.endsWith(')') ? v.slice(1, -1) : v;
  const out: string[] = [];
  let cur = '', quoted = false;
  for (const ch of inner) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function condition(table: TableInfo, alias: string, colRef: string, opExpr: string, p: Params): string {
  const ref = parseColRef(colRef);
  const col = getColumn(table, ref.name);
  const lhs = colExpr(alias, col, ref.path, ref.pathText);
  const jsonPath = !!ref.path?.length;
  // Values are bound as text and cast in SQL: postgres.js would otherwise serialise them
  // with the server-described type (e.g. the string 'true' as boolean false).
  const cast = (ph: string) => (jsonPath ? (ref.pathText ? `${ph}::text` : `to_jsonb(${ph}::text)`) : `${ph}::text::${col.type}`);

  let negate = false;
  let rest = opExpr;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  let op = dot === -1 ? rest : rest.slice(0, dot);
  let value = dot === -1 ? '' : rest.slice(dot + 1);
  let ftsLang: string | undefined;
  const ftsM = op.match(/^(fts|plfts|phfts|wfts)\(([a-z_]+)\)$/);
  if (ftsM) { op = ftsM[1]!; ftsLang = ftsM[2]; }

  let sql: string;
  if (op in OPS) {
    sql = `${lhs} ${OPS[op]} ${cast(p.add(value))}`;
  } else if (op === 'like' || op === 'ilike') {
    sql = `${lhs}::text ${op.toUpperCase()} ${p.add(value.replace(/\*/g, '%'))}::text`;
  } else if (op === 'match' || op === 'imatch') {
    sql = `${lhs}::text ${op === 'match' ? '~' : '~*'} ${p.add(value)}::text`;
  } else if (op === 'in') {
    const items = parseList(value);
    sql = jsonPath && ref.pathText
      ? `${lhs} = ANY(${p.add(items)}::text[])`
      : `${lhs} = ANY(${p.add(items)}::text[]::${col.type}[])`;
  } else if (op === 'is') {
    const v = value.toLowerCase();
    if (!['null', 'true', 'false', 'unknown'].includes(v)) throw new QueryError(400, `'is' accepts null, true, false or unknown`);
    sql = `${lhs} IS ${v.toUpperCase()}`;
  } else if (op === 'cs' || op === 'cd' || op === 'ov') {
    const sym = op === 'cs' ? '@>' : op === 'cd' ? '<@' : '&&';
    sql = `${lhs} ${sym} ${p.add(value)}::text::${col.type}`;
  } else if (['fts', 'plfts', 'phfts', 'wfts'].includes(op)) {
    const fn = { fts: 'to_tsquery', plfts: 'plainto_tsquery', phfts: 'phraseto_tsquery', wfts: 'websearch_to_tsquery' }[op]!;
    const doc = col.udt === 'tsvector' ? lhs : `to_tsvector(${ftsLang ? lit(ftsLang) + '::regconfig, ' : ''}${lhs}::text)`;
    sql = `${doc} @@ ${fn}(${ftsLang ? lit(ftsLang) + '::regconfig, ' : ''}${p.add(value)}::text)`;
  } else {
    throw new QueryError(400, `Unknown operator '${op}'`, 'Supported: eq neq gt gte lt lte like ilike match imatch in is cs cd ov fts plfts phfts wfts');
  }
  return negate ? `NOT (${sql})` : sql;
}

function logicTree(table: TableInfo, alias: string, kind: 'or' | 'and', value: string, p: Params): string {
  const items = splitTopLevel(value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1) : value);
  const parts = items.map((it) => {
    const nested = it.match(/^(not\.)?(or|and)\((.*)\)$/s);
    if (nested) {
      const inner = logicTree(table, alias, nested[2] as 'or' | 'and', `(${nested[3]})`, p);
      return nested[1] ? `NOT ${inner}` : inner;
    }
    const firstDot = it.indexOf('.');
    if (firstDot === -1) throw new QueryError(400, `Invalid condition '${it}'`);
    return condition(table, alias, it.slice(0, firstDot), it.slice(firstDot + 1), p);
  });
  return `(${parts.join(kind === 'or' ? ' OR ' : ' AND ')})`;
}

export function buildWhere(table: TableInfo, alias: string, query: Record<string, string | string[]>, p: Params): string[] {
  const conds: string[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (v === undefined) continue;
      if (key === 'or' || key === 'and') conds.push(logicTree(table, alias, key, v, p));
      else if (key === 'not.or' || key === 'not.and') conds.push(`NOT ${logicTree(table, alias, key.slice(4) as 'or' | 'and', v, p)}`);
      else if (!v.includes('.')) conds.push(condition(table, alias, key, `eq.${v}`, p));
      else conds.push(condition(table, alias, key, v, p));
    }
  }
  return conds;
}

export function buildOrder(table: TableInfo, alias: string, order: string | undefined): string {
  if (!order) return '';
  const parts = order.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [colRef, ...mods] = part.split('.');
    const ref = parseColRef(colRef!);
    const col = getColumn(table, ref.name);
    let dir = 'ASC', nulls = '';
    for (const m of mods) {
      if (m === 'desc') dir = 'DESC';
      else if (m === 'asc') dir = 'ASC';
      else if (m === 'nullsfirst') nulls = ' NULLS FIRST';
      else if (m === 'nullslast') nulls = ' NULLS LAST';
      else throw new QueryError(400, `Invalid order modifier '${m}'`);
    }
    return `${colExpr(alias, col, ref.path, ref.pathText)} ${dir}${nulls}`;
  });
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

// ── Keyset (cursor) pagination ───────────────────────────────────────────────

export function encodeCursor(value: unknown, dir: 'asc' | 'desc'): string {
  return Buffer.from(JSON.stringify({ v: value, d: dir })).toString('base64url');
}

export function decodeCursor(c: string): { v: unknown; d: 'asc' | 'desc' } {
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (!('v' in o)) throw new Error();
    return { v: o.v, d: o.d === 'desc' ? 'desc' : 'asc' };
  } catch {
    throw new QueryError(400, 'Invalid cursor');
  }
}

// ── Pagination ───────────────────────────────────────────────────────────────

export function parsePaging(query: Record<string, any>, rangeHeader: string | undefined, maxRows: number) {
  let limit = query['limit'] !== undefined ? Number(query['limit']) : undefined;
  let offset = query['offset'] !== undefined ? Number(query['offset']) : 0;
  const m = rangeHeader?.match(/^(\d+)-(\d*)$/);
  if (m) {
    offset = Number(m[1]);
    if (m[2]) limit = Number(m[2]) - offset + 1;
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new QueryError(400, 'limit must be a non-negative integer');
  if (!Number.isInteger(offset) || offset < 0) throw new QueryError(400, 'offset must be a non-negative integer');
  return { limit: Math.min(limit ?? maxRows, maxRows), offset };
}

export function parsePrefer(h: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(',')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k.trim()] = (v ?? '').trim();
  }
  return out;
}

export function writableColumns(table: TableInfo, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const c = getColumn(table, k);
    if (c.is_generated) throw new QueryError(400, `Column '${k}' is generated and cannot be written`);
    out.push(k);
  }
  return out;
}
