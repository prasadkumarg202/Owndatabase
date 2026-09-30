/**
 * GraphQL over the project schema:  POST|GET /graphql/v1/:projectId
 *
 * The schema is generated from the tables (and foreign keys) the REST API sees:
 *
 *   query {
 *     orders(where: { status: { eq: "paid" }, total: { gte: 100 } }, orderBy: [{ created_at: DESC }], limit: 10) {
 *       id total
 *       customer { name }                  # many-to-one  (customer_id → customers)
 *       order_items(limit: 5) { qty }      # one-to-many  (order_items.order_id → orders)
 *     }
 *     orders_by_pk(id: 1) { id }
 *     orders_count(where: { status: { eq: "paid" } })
 *   }
 *   mutation {
 *     insert_orders(objects: [{ total: 10 }]) { id }
 *     update_orders(where: { id: { eq: 1 } }, set: { status: "shipped" }) { id status }
 *     delete_orders(where: { id: { eq: 1 } }) { id }
 *   }
 *
 * Every root field compiles to ONE SQL statement (nested json subqueries, no
 * N+1) and runs as the caller's role with its JWT claims, exactly like REST,
 * so grants and Row Level Security apply.
 */
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLError, GraphQLFloat, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, Kind, execute, parse, specifiedRules, validate,
  type FieldNode, type FragmentDefinitionNode, type GraphQLFieldConfigMap, type GraphQLInputFieldConfigMap, type GraphQLInputType,
  type GraphQLOutputType, type GraphQLResolveInfo, type SelectionSetNode, type ValidationRule, type ASTVisitor, type ValidationContext,
} from 'graphql';
import { getArgumentValues } from 'graphql/execution/values.js';
import type { ColumnInfo, SchemaInfo, TableInfo } from './schema-cache.js';
import { ident, Params } from './query-builder.js';

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const MAX_DEPTH = 8;

// ── scalars ─────────────────────────────────────────────────────────────────
const JSONScalar = new GraphQLScalarType({
  name: 'JSON', description: 'Any JSON value',
  serialize: (v) => v, parseValue: (v) => v,
  parseLiteral: function lit(ast: any): unknown {
    switch (ast.kind) {
      case Kind.STRING: case Kind.BOOLEAN: return ast.value;
      case Kind.INT: case Kind.FLOAT: return Number(ast.value);
      case Kind.OBJECT: return Object.fromEntries(ast.fields.map((f: any) => [f.name.value, lit(f.value)]));
      case Kind.LIST: return ast.values.map(lit);
      default: return null;
    }
  },
});
const stringScalar = (name: string, description: string) => new GraphQLScalarType({
  name, description, serialize: (v) => (v === null ? null : String(v)), parseValue: (v) => String(v),
  parseLiteral: (ast: any) => (ast.kind === Kind.STRING || ast.kind === Kind.INT || ast.kind === Kind.FLOAT ? String(ast.value) : undefined),
});
const BigIntScalar = stringScalar('BigInt', '64-bit integer, as a string');
const BigFloatScalar = stringScalar('BigFloat', 'Arbitrary-precision number, as a string');
const DatetimeScalar = stringScalar('Datetime', 'ISO 8601 timestamp');
const UUIDScalar = stringScalar('UUID', 'UUID');

type ScalarKind = 'int' | 'bigint' | 'float' | 'bigfloat' | 'bool' | 'string' | 'uuid' | 'datetime' | 'json';

function kindOf(c: ColumnInfo): { kind: ScalarKind; array: boolean } {
  const array = c.udt.startsWith('_');
  const u = array ? c.udt.slice(1) : c.udt;
  const kind: ScalarKind =
    ['int2', 'int4'].includes(u) ? 'int' : u === 'int8' ? 'bigint'
    : ['float4', 'float8'].includes(u) ? 'float' : u === 'numeric' ? 'bigfloat'
    : u === 'bool' ? 'bool' : u === 'uuid' ? 'uuid'
    : ['timestamptz', 'timestamp', 'date', 'time', 'timetz'].includes(u) ? 'datetime'
    : ['json', 'jsonb'].includes(u) ? 'json' : 'string';
  return { kind, array };
}
const SCALAR: Record<ScalarKind, GraphQLScalarType> = {
  int: GraphQLInt, bigint: BigIntScalar, float: GraphQLFloat, bigfloat: BigFloatScalar, bool: GraphQLBoolean,
  string: GraphQLString, uuid: UUIDScalar, datetime: DatetimeScalar, json: JSONScalar,
};
/** SQL for a column value in the JSON result (64-bit / numeric as text: JSON numbers lose precision). */
const colExpr = (alias: string, c: ColumnInfo) => {
  const { kind, array } = kindOf(c);
  const ref = `${alias}.${ident(c.name)}`;
  return !array && (kind === 'bigint' || kind === 'bigfloat') ? `${ref}::text` : ref;
};

const FilterIs = new GraphQLEnumType({ name: 'FilterIs', values: { NULL: {}, NOT_NULL: {} } });
const OrderDirection = new GraphQLEnumType({
  name: 'OrderDirection',
  values: { ASC: { value: 'ASC NULLS LAST' }, DESC: { value: 'DESC NULLS FIRST' }, ASC_NULLS_FIRST: { value: 'ASC NULLS FIRST' },
    ASC_NULLS_LAST: { value: 'ASC NULLS LAST' }, DESC_NULLS_FIRST: { value: 'DESC NULLS FIRST' }, DESC_NULLS_LAST: { value: 'DESC NULLS LAST' } },
});

const comparisonTypes = new Map<ScalarKind, GraphQLInputObjectType>();
function comparison(kind: ScalarKind): GraphQLInputObjectType {
  const hit = comparisonTypes.get(kind);
  if (hit) return hit;
  const s = SCALAR[kind];
  const fields: GraphQLInputFieldConfigMap = { is: { type: FilterIs } };
  if (kind !== 'json') {
    fields['eq'] = { type: s }; fields['neq'] = { type: s }; fields['in'] = { type: new GraphQLList(new GraphQLNonNull(s)) };
  }
  if (!['bool', 'json', 'uuid'].includes(kind)) { for (const op of ['gt', 'gte', 'lt', 'lte']) fields[op] = { type: s }; }
  if (kind === 'string') { fields['like'] = { type: GraphQLString }; fields['ilike'] = { type: GraphQLString }; }
  const t = new GraphQLInputObjectType({ name: `${s.name}Comparison`, fields });
  comparisonTypes.set(kind, t);
  return t;
}

// ── schema generation ──────────────────────────────────────────────────────
interface RelField { name: string; kind: 'one' | 'many'; target: string; pairs: [string, string][] /* [local col, remote col] */ }
interface TableGql { table: TableInfo; typeName: string; rels: RelField[] }

export interface BuiltSchema { schema: GraphQLSchema; tables: Map<string, TableGql> }

const pascal = (s: string) => s.replace(/(^|_)([a-z0-9])/g, (_m, _p, c: string) => c.toUpperCase()).replace(/[^_0-9A-Za-z]/g, '');

export function buildSchema(info: SchemaInfo): BuiltSchema {
  const tables = new Map<string, TableGql>();
  const used = new Set<string>();
  for (const t of info.tables.values()) {
    if (!NAME.test(t.name) || t.columns.every((c) => !NAME.test(c.name))) continue;
    let typeName = pascal(t.name) || 'T';
    if (/^__|^(Query|Mutation|JSON|BigInt|BigFloat|Datetime|UUID|FilterIs|OrderDirection|String|Int|Float|Boolean)$/.test(typeName)) typeName += 'Row';
    while (used.has(typeName)) typeName += '_';
    used.add(typeName);
    tables.set(t.name, { table: t, typeName, rels: [] });
  }
  // relations, both directions
  for (const r of info.relations) {
    const from = tables.get(r.from_table), to = tables.get(r.to_table);
    if (!from || !to) continue;
    const pairs = r.from_columns.map((c, i) => [c, r.to_columns[i]!] as [string, string]);
    let one = r.from_columns.length === 1 && r.from_columns[0]!.endsWith('_id') ? r.from_columns[0]!.slice(0, -3) : `${r.to_table}_by_${r.from_columns.join('_')}`;
    if (!NAME.test(one) || from.table.columnMap.has(one) || from.rels.some((x) => x.name === one)) one = `${r.to_table}_by_${r.from_columns.join('_')}`;
    from.rels.push({ name: one, kind: 'one', target: r.to_table, pairs });
    let many = r.from_table;
    if (to.table.columnMap.has(many) || to.rels.some((x) => x.name === many)) many = `${r.from_table}_by_${r.from_columns.join('_')}`;
    to.rels.push({ name: many, kind: 'many', target: r.from_table, pairs: pairs.map(([a, b]) => [b, a]) });
  }

  const objectTypes = new Map<string, GraphQLObjectType>();
  const filterTypes = new Map<string, GraphQLInputObjectType>();
  const orderTypes = new Map<string, GraphQLInputObjectType>();
  const cols = (t: TableInfo) => t.columns.filter((c) => NAME.test(c.name));

  for (const [name, g] of tables) {
    const filter: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: `${g.typeName}Filter`,
      fields: () => ({
        ...Object.fromEntries(cols(g.table).map((c) => [c.name, { type: comparison(kindOf(c).array ? 'json' : kindOf(c).kind) }])),
        and: { type: new GraphQLList(new GraphQLNonNull(filter)) },
        or: { type: new GraphQLList(new GraphQLNonNull(filter)) },
        not: { type: filter },
      }),
    });
    filterTypes.set(name, filter);
    orderTypes.set(name, new GraphQLInputObjectType({
      name: `${g.typeName}OrderBy`, fields: Object.fromEntries(cols(g.table).map((c) => [c.name, { type: OrderDirection }])),
    }));
  }
  const listArgs = (target: string) => ({
    where: { type: filterTypes.get(target)! },
    orderBy: { type: new GraphQLList(new GraphQLNonNull(orderTypes.get(target)!)) },
    limit: { type: GraphQLInt }, offset: { type: GraphQLInt },
  });
  for (const [name, g] of tables) {
    objectTypes.set(name, new GraphQLObjectType({
      name: g.typeName,
      description: g.table.comment ?? undefined,
      fields: () => {
        const f: GraphQLFieldConfigMap<any, any> = {};
        for (const c of cols(g.table)) {
          const { kind, array } = kindOf(c);
          let type: GraphQLOutputType = array ? new GraphQLList(SCALAR[kind]) : SCALAR[kind];
          if (!c.nullable) type = new GraphQLNonNull(type);
          f[c.name] = { type };
        }
        for (const r of g.rels) {
          const target = objectTypes.get(r.target)!;
          f[r.name] = r.kind === 'one'
            ? { type: target }
            : { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(target))), args: listArgs(r.target) };
        }
        return f;
      },
    }));
  }

  const query: GraphQLFieldConfigMap<any, any> = {};
  const mutation: GraphQLFieldConfigMap<any, any> = {};
  for (const [name, g] of tables) {
    const obj = objectTypes.get(name)!;
    const list = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(obj)));
    query[name] = { type: list, args: listArgs(name), resolve: rootResolver('list', name) };
    query[`${name}_count`] = { type: new GraphQLNonNull(GraphQLInt), args: { where: { type: filterTypes.get(name)! } }, resolve: rootResolver('count', name) };
    const pkCols = g.table.pk.map((k) => g.table.columnMap.get(k)!).filter(Boolean);
    if (pkCols.length && pkCols.every((c) => NAME.test(c.name))) {
      query[`${name}_by_pk`] = {
        type: obj,
        args: Object.fromEntries(pkCols.map((c) => [c.name, { type: new GraphQLNonNull(SCALAR[kindOf(c).kind]) }])),
        resolve: rootResolver('by_pk', name),
      };
    }
    if (g.table.kind !== 'table') continue;
    const writable = cols(g.table).filter((c) => !c.is_generated && !c.is_identity_always);
    if (!writable.length) continue;
    const valueFields = () => Object.fromEntries(writable.map((c) => {
      const { kind, array } = kindOf(c);
      return [c.name, { type: (array ? new GraphQLList(SCALAR[kind]) : SCALAR[kind]) as GraphQLInputType }];
    }));
    const insertType = new GraphQLInputObjectType({ name: `${g.typeName}Insert`, fields: valueFields });
    const updateType = new GraphQLInputObjectType({ name: `${g.typeName}Update`, fields: valueFields });
    mutation[`insert_${name}`] = { type: list, args: { objects: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(insertType))) } }, resolve: rootResolver('insert', name) };
    mutation[`update_${name}`] = { type: list, args: { where: { type: new GraphQLNonNull(filterTypes.get(name)!) }, set: { type: new GraphQLNonNull(updateType) } }, resolve: rootResolver('update', name) };
    mutation[`delete_${name}`] = { type: list, args: { where: { type: new GraphQLNonNull(filterTypes.get(name)!) } }, resolve: rootResolver('delete', name) };
  }
  if (!Object.keys(query).length) {
    query['_empty'] = { type: GraphQLBoolean, description: 'The schema has no tables yet', resolve: () => null };
  }
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: query }),
    ...(Object.keys(mutation).length ? { mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutation }) } : {}),
  });
  return { schema, tables };
}

// ── SQL compilation ─────────────────────────────────────────────────────────
export interface GqlContext {
  schemaName: string;
  built: BuiltSchema;
  run: (sql: string, values: unknown[]) => Promise<unknown>;
  maxRows: number;
}

type Resolved = { key: string; name: string; node: FieldNode };

/** Flattens fragments and applies @skip/@include; keys are the response keys (aliases). */
function fieldsOf(set: SelectionSetNode | undefined, info: GraphQLResolveInfo, out: Resolved[] = []): Resolved[] {
  for (const sel of set?.selections ?? []) {
    const skip = (sel.directives ?? []).some((d) => {
      const arg = d.arguments?.find((a) => a.name.value === 'if')?.value;
      const v = !arg ? true : arg.kind === Kind.VARIABLE ? !!info.variableValues[arg.name.value] : arg.kind === Kind.BOOLEAN ? arg.value : true;
      return (d.name.value === 'skip' && v) || (d.name.value === 'include' && !v);
    });
    if (skip) continue;
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value !== '__typename') out.push({ key: sel.alias?.value ?? sel.name.value, name: sel.name.value, node: sel });
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      fieldsOf(sel.selectionSet, info, out);
    } else {
      fieldsOf((info.fragments[sel.name.value] as FragmentDefinitionNode | undefined)?.selectionSet, info, out);
    }
  }
  return out;
}

function objectExpr(ctx: GqlContext, info: GraphQLResolveInfo, g: TableGql, alias: string, set: SelectionSetNode | undefined, p: Params, depth: number): string {
  if (depth > MAX_DEPTH) throw new GraphQLError(`Query is nested deeper than ${MAX_DEPTH} levels`);
  const type = info.schema.getType(g.typeName) as GraphQLObjectType;
  const pairs: string[] = [];
  for (const f of fieldsOf(set, info)) {
    const col = g.table.columnMap.get(f.name);
    if (col) { pairs.push(`'${f.key}', ${colExpr(alias, col)}`); continue; }
    const rel = g.rels.find((r) => r.name === f.name);
    if (!rel) continue;
    const target = ctx.built.tables.get(rel.target)!;
    const a2 = `t${depth + 1}_${pairs.length}`;
    const join = rel.pairs.map(([local, remote]) => `${a2}.${ident(remote)} = ${alias}.${ident(local)}`).join(' AND ');
    if (rel.kind === 'one') {
      pairs.push(`'${f.key}', (SELECT ${objectExpr(ctx, info, target, a2, f.node.selectionSet, p, depth + 1)} FROM ${ident(ctx.schemaName)}.${ident(rel.target)} ${a2} WHERE ${join} LIMIT 1)`);
    } else {
      const args = getArgumentValues(type.getFields()[f.name]!, f.node, info.variableValues) as Record<string, any>;
      pairs.push(`'${f.key}', ${listExpr(ctx, info, target, a2, f.node.selectionSet, args, p, depth + 1, join)}`);
    }
  }
  if (!pairs.length) return `'{}'::jsonb`;
  // jsonb_build_object takes at most 100 arguments: build in chunks
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += 50) chunks.push(`jsonb_build_object(${pairs.slice(i, i + 50).join(', ')})`);
  return chunks.join(' || ');
}

function orderSql(g: TableGql, alias: string, orderBy: Record<string, string>[] | undefined): string {
  const parts: string[] = [];
  for (const o of orderBy ?? []) for (const [col, dir] of Object.entries(o)) if (g.table.columnMap.has(col) && dir) parts.push(`${alias}.${ident(col)} ${dir}`);
  if (!parts.length) parts.push(...(g.table.pk.length ? g.table.pk.map((k) => `${alias}.${ident(k)}`) : ['1']));
  return parts.join(', ');
}

function filterSql(g: TableGql, alias: string, where: Record<string, any> | undefined | null, p: Params): string {
  if (!where) return 'TRUE';
  const parts: string[] = [];
  for (const [key, val] of Object.entries(where)) {
    if (val === null || val === undefined) continue;
    if (key === 'and') { parts.push(`(${(val as any[]).map((w) => filterSql(g, alias, w, p)).join(' AND ') || 'TRUE'})`); continue; }
    if (key === 'or') { parts.push(`(${(val as any[]).map((w) => filterSql(g, alias, w, p)).join(' OR ') || 'FALSE'})`); continue; }
    if (key === 'not') { parts.push(`NOT (${filterSql(g, alias, val, p)})`); continue; }
    const c = g.table.columnMap.get(key);
    if (!c) continue;
    const ref = `${alias}.${ident(c.name)}`;
    for (const [op, v] of Object.entries(val as Record<string, any>)) {
      if (v === undefined) continue;
      if (op === 'is') { parts.push(`${ref} IS ${v === 'NULL' ? 'NULL' : 'NOT NULL'}`); continue; }
      if (v === null) { parts.push(op === 'neq' ? `${ref} IS NOT NULL` : `${ref} IS NULL`); continue; }
      const sqlOp = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[op];
      if (sqlOp) parts.push(`${ref} ${sqlOp} ${p.add(v)}::${c.type}`);
      else if (op === 'in') parts.push(`${ref} = ANY(${p.add(v)}::${c.type}[])`);
      else if (op === 'like' || op === 'ilike') parts.push(`${ref}::text ${op.toUpperCase()} ${p.add(v)}::text`);
    }
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

function listExpr(ctx: GqlContext, info: GraphQLResolveInfo, g: TableGql, alias: string, set: SelectionSetNode | undefined,
  args: Record<string, any>, p: Params, depth: number, join = 'TRUE', from?: string): string {
  const limit = Math.min(Math.max(Number(args['limit'] ?? ctx.maxRows) || 0, 0), ctx.maxRows);
  const offset = Math.max(Number(args['offset'] ?? 0) || 0, 0);
  const order = orderSql(g, alias, args['orderBy']);
  return `(SELECT coalesce(jsonb_agg(s.o ORDER BY s.rn), '[]'::jsonb) FROM (
    SELECT ${objectExpr(ctx, info, g, alias, set, p, depth)} AS o, row_number() OVER (ORDER BY ${order}) AS rn
    FROM ${from ?? `${ident(ctx.schemaName)}.${ident(g.table.name)}`} ${alias}
    WHERE ${join} AND ${filterSql(g, alias, args['where'], p)}
    ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}) s)`;
}

function rootResolver(kind: 'list' | 'count' | 'by_pk' | 'insert' | 'update' | 'delete', table: string) {
  return async (_src: unknown, args: Record<string, any>, ctx: GqlContext, info: GraphQLResolveInfo) => {
    const g = ctx.built.tables.get(table)!;
    const p = new Params();
    const fq = `${ident(ctx.schemaName)}.${ident(table)}`;
    const set = info.fieldNodes[0]!.selectionSet;
    let sql: string;
    if (kind === 'list') {
      sql = `SELECT ${listExpr(ctx, info, g, 't0', set, args, p, 0)} AS r`;
    } else if (kind === 'count') {
      sql = `SELECT count(*)::int AS r FROM ${fq} t0 WHERE ${filterSql(g, 't0', args['where'], p)}`;
    } else if (kind === 'by_pk') {
      const cond = g.table.pk.map((k) => `t0.${ident(k)} = ${p.add(args[k])}::${g.table.columnMap.get(k)!.type}`).join(' AND ');
      sql = `SELECT (SELECT ${objectExpr(ctx, info, g, 't0', set, p, 0)} FROM ${fq} t0 WHERE ${cond} LIMIT 1) AS r`;
    } else if (kind === 'insert') {
      const rows = args['objects'] as Record<string, unknown>[];
      if (!rows.length) return [];
      if (rows.length > ctx.maxRows) throw new GraphQLError(`At most ${ctx.maxRows} objects per insert`);
      const colNames = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => g.table.columnMap.has(k));
      let stmt: string;
      if (!colNames.length) stmt = `INSERT INTO ${fq} DEFAULT VALUES RETURNING *`;
      else {
        const values = rows.map((r) => `(${colNames.map((k) => (k in r ? `${p.add(r[k])}::${g.table.columnMap.get(k)!.type}` : 'DEFAULT')).join(', ')})`);
        stmt = `INSERT INTO ${fq} (${colNames.map(ident).join(', ')}) VALUES ${values.join(', ')} RETURNING *`;
      }
      sql = `WITH w AS (${stmt}) SELECT ${listExpr(ctx, info, g, 't0', set, { limit: rows.length }, p, 0, 'TRUE', 'w')} AS r`;
    } else if (kind === 'update') {
      const setVals = Object.entries(args['set'] as Record<string, unknown>).filter(([k]) => g.table.columnMap.has(k));
      if (!setVals.length) throw new GraphQLError('set must name at least one column');
      const assign = setVals.map(([k, v]) => `${ident(k)} = ${p.add(v)}::${g.table.columnMap.get(k)!.type}`).join(', ');
      sql = `WITH w AS (UPDATE ${fq} AS u SET ${assign} WHERE ${filterSql(g, 'u', args['where'], p)} RETURNING u.*)
             SELECT ${listExpr(ctx, info, g, 't0', set, { limit: ctx.maxRows }, p, 0, 'TRUE', 'w')} AS r`;
    } else {
      sql = `WITH w AS (DELETE FROM ${fq} AS u WHERE ${filterSql(g, 'u', args['where'], p)} RETURNING u.*)
             SELECT ${listExpr(ctx, info, g, 't0', set, { limit: ctx.maxRows }, p, 0, 'TRUE', 'w')} AS r`;
    }
    const r = await ctx.run(sql, p.values);
    return r;
  };
}

/** The default resolver reads the response key (aliases), since the SQL builds objects keyed by alias. */
const aliasResolver = (source: any, _args: unknown, _ctx: unknown, info: GraphQLResolveInfo) =>
  source && typeof source === 'object' ? source[info.path.key as string] : undefined;

/** Rejects queries nested deeper than MAX_DEPTH before any SQL is built. */
const depthLimit: ValidationRule = (vc: ValidationContext): ASTVisitor => ({
  Field: { enter(_node, _k, _p, _path, ancestors) {
    const depth = ancestors.filter((a: any) => a && a.kind === Kind.FIELD).length;
    if (depth > MAX_DEPTH) vc.reportError(new GraphQLError(`Query is nested deeper than ${MAX_DEPTH} levels`));
  } },
});

export async function runGraphql(built: BuiltSchema, ctx: Omit<GqlContext, 'built'>, body: { query?: string; variables?: Record<string, unknown> | null; operationName?: string | null },
  opts: { readOnly?: boolean } = {}) {
  if (!body.query || typeof body.query !== 'string') return { status: 400, result: { errors: [{ message: 'Send { query, variables? }' }] } };
  let doc;
  try { doc = parse(body.query, { maxTokens: 5000 }); } catch (err) { return { status: 400, result: { errors: [{ message: (err as Error).message }] } }; }
  const errors = validate(built.schema, doc, [...specifiedRules, depthLimit]);
  if (errors.length) return { status: 400, result: { errors: errors.map((e) => ({ message: e.message, locations: e.locations })) } };
  // read-only (over the database size limit): like REST, deletes stay allowed so data can be trimmed
  if (opts.readOnly && doc.definitions.some((d: any) => d.kind === Kind.OPERATION_DEFINITION && d.operation === 'mutation'
    && d.selectionSet.selections.some((s: any) => s.kind !== Kind.FIELD || !s.name.value.startsWith('delete_')))) {
    return { status: 402, result: { errors: [{ message: 'This project is over its database size limit and is read-only' }] } };
  }
  const result = await execute({
    schema: built.schema, document: doc, variableValues: body.variables ?? undefined, operationName: body.operationName ?? undefined,
    contextValue: { ...ctx, built }, fieldResolver: aliasResolver,
  });
  return { status: 200, result };
}
