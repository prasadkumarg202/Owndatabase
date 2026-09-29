/**
 * Auto-generated REST API over the project's schema (PostgREST-compatible subset).
 *
 *   GET    /v1/:projectId/:table        read (filters, select/embedding, order, paging, count)
 *   POST   /v1/:projectId/:table        insert one or many (upsert with Prefer: resolution=…)
 *   PATCH  /v1/:projectId/:table        update rows matching filters
 *   DELETE /v1/:projectId/:table        delete rows matching filters
 *   GET|PATCH|DELETE /v1/:projectId/:table/:id   convenience by single-column primary key
 *
 * Every statement runs inside a transaction as anon / authenticated /
 * service_role with request.jwt.claims set, so Row Level Security applies.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { poolerDb } from '../lib/db.js';
import { routedRead } from '../lib/replica.js';
import { getSchema, type TableInfo } from '../lib/schema-cache.js';
import { withRole } from '../lib/platform-auth.js';
import { config } from '../config.js';
import {
  Params, QueryError, buildOrder, buildSelectList, buildWhere, decodeCursor, encodeCursor, getTable, ident,
  parsePaging, parsePrefer, parseSelect, writableColumns,
} from '../lib/query-builder.js';

type Q = Record<string, string | string[]>;

export function sendError(reply: FastifyReply, err: any, role?: string) {
  if (err instanceof QueryError) {
    return reply.status(err.statusCode).send({ error: 'Bad Request', message: err.message, hint: err.hint });
  }
  const map: Record<string, number> = {
    '23505': 409, '23503': 409, '23502': 400, '23514': 400, '22P02': 400, '22007': 400, '22003': 400,
    '42703': 400, '42P01': 404, '42883': 404, '57014': 504, 'P0001': 400, '22023': 400, '42P10': 400, '0A000': 400,
    '21000': 400, '25006': 405,
  };
  if (err?.code === '42501') {
    return reply.status(role === 'anon' ? 401 : 403).send({ error: 'Forbidden', code: err.code, message: err.message, hint: 'Check the table\'s Row Level Security policies and grants.' });
  }
  if (err?.code && map[err.code]) {
    return reply.status(map[err.code]!).send({ error: 'Database Error', code: err.code, message: err.message, details: err.detail ?? null, hint: err.hint ?? null });
  }
  reply.log.error({ err }, 'REST query failed');
  return reply.status(500).send({ error: 'Internal Server Error', message: 'Query failed' });
}

async function tableFor(req: FastifyRequest): Promise<{ table: TableInfo; schema: Awaited<ReturnType<typeof getSchema>> }> {
  const { table } = req.params as { table: string };
  const schema = await getSchema(req.auth.project.id, req.auth.project.db_schema);
  return { schema, table: getTable(schema, table) };
}

function wantsSingle(req: FastifyRequest) {
  return String(req.headers['accept'] ?? '').includes('application/vnd.pgrst.object+json') || (req.query as Q)['single'] === 'true';
}

function respondRows(req: FastifyRequest, reply: FastifyReply, body: string, status = 200, forceSingle = false) {
  if (forceSingle || wantsSingle(req)) {
    const rows = JSON.parse(body) as unknown[];
    if (rows.length !== 1) {
      return reply.status(406).send({ error: 'Not Acceptable', message: `JSON object requested, multiple (or no) rows returned (${rows.length})` });
    }
    return reply.status(status).type('application/json').send(JSON.stringify(rows[0]));
  }
  return reply.status(status).type('application/json; charset=utf-8').send(body);
}

export default async function restRoutes(server: FastifyInstance) {
  const fq = (req: FastifyRequest, t: TableInfo) => `${ident(req.auth.project.db_schema)}.${ident(t.name)}`;

  // ── Read ───────────────────────────────────────────────────────────────────
  const read = async (req: FastifyRequest, reply: FastifyReply, byId?: string) => {
    try {
      const { table, schema } = await tableFor(req);
      const q = { ...(req.query as Q) };
      if (byId !== undefined) {
        if (table.pk.length !== 1) throw new QueryError(400, 'Lookup by id needs a single-column primary key');
        q[table.pk[0]!] = `eq.${byId}`;
        q['single'] = 'true';
      }
      const p = new Params();
      const nodes = parseSelect(q['select'] as string | undefined);
      const sel = buildSelectList(schema, table, 't', nodes);
      const where = [...buildWhere(table, 't', q, p), ...sel.innerJoins];
      let order = buildOrder(table, 't', q['order'] as string | undefined);
      const { limit, offset } = parsePaging(q, req.headers['range'] as string | undefined, config.MAX_ROWS);

      // keyset pagination
      let cursorCol: string | null = null;
      let cursorDir: 'asc' | 'desc' = 'asc';
      if (q['cursor'] !== undefined) {
        if (table.pk.length !== 1) throw new QueryError(400, 'Cursor pagination needs a single-column primary key');
        cursorCol = table.pk[0]!;
        const col = table.columnMap.get(cursorCol)!;
        const orderParam = String(q['order'] ?? '');
        cursorDir = orderParam.startsWith(`${cursorCol}.desc`) ? 'desc' : 'asc';
        if (q['cursor']) {
          const c = decodeCursor(q['cursor'] as string);
          cursorDir = c.d;
          where.push(`t.${ident(cursorCol)} ${cursorDir === 'asc' ? '>' : '<'} ${p.add(String(c.v))}::text::${col.type}`);
        }
        order = `ORDER BY t.${ident(cursorCol)} ${cursorDir.toUpperCase()}`;
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const prefer = parsePrefer(req.headers['prefer'] as string | undefined);
      const countMode = (q['count'] as string | undefined) ?? prefer['count'];
      const sql = `SELECT COALESCE(json_agg(_r), '[]')::text AS body FROM (
        SELECT ${sel.list} FROM ${fq(req, table)} t ${whereSql} ${order} LIMIT ${limit} ${cursorCol ? '' : `OFFSET ${offset}`}) _r`;

      const { result: { body, total }, from } = await routedRead(req, (pool) => withRole(pool, req.auth, async (tx) => {
        const [row] = await tx.unsafe(sql, p.values as any[]);
        let total: number | null = null;
        if (countMode === 'exact') {
          const [c] = await tx.unsafe(`SELECT count(*)::bigint AS n FROM ${fq(req, table)} t ${whereSql}`, p.values as any[]);
          total = Number(c!['n']);
        } else if (countMode === 'planned' || countMode === 'estimated') {
          const [c] = await tx.unsafe(`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::text::regclass`, [`${ident(req.auth.project.db_schema)}.${ident(table.name)}`]);
          total = Math.max(0, Number(c!['n']));
        }
        return { body: row!['body'] as string, total };
      }, config.STATEMENT_TIMEOUT_MS));
      reply.header('x-odb-read-from', from);

      const rows = JSON.parse(body) as any[];
      const end = rows.length ? offset + rows.length - 1 : offset;
      reply.header('Content-Range', `${rows.length ? `${offset}-${end}` : '*'}/${total ?? '*'}`);
      if (cursorCol && rows.length === limit && rows[rows.length - 1]?.[cursorCol] !== undefined) {
        reply.header('X-Next-Cursor', encodeCursor(rows[rows.length - 1][cursorCol], cursorDir));
      }
      if (byId !== undefined && rows.length === 0) return reply.status(404).send({ error: 'Not Found', message: 'Row not found' });
      return respondRows(req, reply, body, total !== null && rows.length < total && byId === undefined ? 206 : 200, byId !== undefined);
    } catch (err) {
      return sendError(reply, err, req.auth?.role);
    }
  };

  server.get('/v1/:projectId/:table', (req, reply) => read(req, reply));
  server.head('/v1/:projectId/:table', (req, reply) => read(req, reply));
  server.get('/v1/:projectId/:table/:id', (req, reply) => read(req, reply, (req.params as any).id));

  // ── Insert / upsert ────────────────────────────────────────────────────────
  server.post('/v1/:projectId/:table', async (req, reply) => {
    try {
      const { table, schema } = await tableFor(req);
      if (table.kind === 'view' && !table.columns.length) throw new QueryError(405, 'View is not insertable');
      const body = req.body as unknown;
      const rows = Array.isArray(body) ? body : [body];
      if (!rows.length || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        throw new QueryError(400, 'Body must be a JSON object or an array of objects');
      }
      const q = req.query as Q;
      const prefer = parsePrefer(req.headers['prefer'] as string | undefined);
      const p = new Params();

      // Rows with different key sets are inserted in separate statements so a
      // missing key falls back to the column DEFAULT instead of NULL.
      const groups = new Map<string, Record<string, unknown>[]>();
      if (q['columns']) {
        groups.set(String(q['columns']), rows as Record<string, unknown>[]);
      } else {
        for (const r of rows as Record<string, unknown>[]) {
          const sig = Object.keys(r).sort().join(',');
          groups.set(sig, [...(groups.get(sig) ?? []), r]);
        }
      }
      const upsert = prefer['resolution'] === 'merge-duplicates' || prefer['resolution'] === 'ignore-duplicates' || q['upsert'] === 'true';
      const conflict = q['on_conflict'] ? String(q['on_conflict']).split(',').map((s) => s.trim()) : table.pk;
      if (upsert) {
        if (!conflict.length) throw new QueryError(400, 'Upsert needs on_conflict columns or a primary key');
        conflict.forEach((c) => { if (!table.columnMap.has(c)) throw new QueryError(400, `Unknown on_conflict column '${c}'`); });
      }
      const ctes: string[] = [];
      let i = 0;
      for (const [sig, groupRows] of groups) {
        const cols = writableColumns(table, sig ? sig.split(',').map((s) => s.trim()).filter(Boolean) : []);
        const colList = cols.map(ident).join(', ');
        if (!cols.length && groupRows.length > 1) throw new QueryError(400, 'Cannot insert several empty rows in one request');
        let stmt = cols.length
          ? `INSERT INTO ${fq(req, table)} (${colList})${cols.some((c) => table.columnMap.get(c)?.is_identity_always) ? ' OVERRIDING SYSTEM VALUE' : ''} SELECT ${colList} FROM json_populate_recordset(NULL::${fq(req, table)}, ${p.add(JSON.stringify(groupRows))}::text::json)`
          : `INSERT INTO ${fq(req, table)} DEFAULT VALUES`;
        if (upsert && cols.length) {
          const updates = cols.filter((c) => !conflict.includes(c));
          stmt += prefer['resolution'] === 'ignore-duplicates' || !updates.length
            ? ` ON CONFLICT (${conflict.map(ident).join(', ')}) DO NOTHING`
            : ` ON CONFLICT (${conflict.map(ident).join(', ')}) DO UPDATE SET ${updates.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`;
        }
        ctes.push(`w${i++} AS (${stmt} RETURNING *)`);
      }
      const union = ctes.map((_c, j) => `SELECT * FROM w${j}`).join(' UNION ALL ');
      const returnMinimal = prefer['return'] === 'minimal';
      const sel = buildSelectList(schema, table, 't', parseSelect(q['select'] as string | undefined));
      const final = returnMinimal
        ? `WITH ${ctes.join(', ')}, w AS (${union}) SELECT count(*)::int AS n, '[]' AS body FROM w`
        : `WITH ${ctes.join(', ')}, w AS (${union}) SELECT (SELECT count(*)::int FROM w) AS n, COALESCE((SELECT json_agg(_r) FROM (SELECT ${sel.list} FROM w t) _r), '[]')::text AS body`;
      const res = await withRole(poolerDb, req.auth, async (tx) => (await tx.unsafe(final, p.values as any[]))[0]!, config.STATEMENT_TIMEOUT_MS);
      reply.header('Content-Range', `*/${res['n']}`);
      if (returnMinimal) return reply.status(201).send();
      return respondRows(req, reply, res['body'] as string, 201);
    } catch (err) {
      return sendError(reply, err, req.auth?.role);
    }
  });

  // ── Update ─────────────────────────────────────────────────────────────────
  const update = async (req: FastifyRequest, reply: FastifyReply, byId?: string) => {
    try {
      const { table, schema } = await tableFor(req);
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) {
        throw new QueryError(400, 'Body must be a non-empty JSON object');
      }
      const q = { ...(req.query as Q) };
      if (byId !== undefined) {
        if (table.pk.length !== 1) throw new QueryError(400, 'Lookup by id needs a single-column primary key');
        q[table.pk[0]!] = `eq.${byId}`;
      }
      const cols = writableColumns(table, Object.keys(body));
      const p = new Params();
      const rec = p.add(JSON.stringify(body));
      const where = buildWhere(table, 't', q, p);
      if (!where.length) throw new QueryError(400, 'UPDATE requires at least one filter', 'Add a filter such as ?id=eq.1');
      const colList = cols.map(ident).join(', ');
      const set = cols.length === 1
        ? `${colList} = (SELECT ${colList} FROM json_populate_record(NULL::${fq(req, table)}, ${rec}::text::json))`
        : `(${colList}) = (SELECT ${colList} FROM json_populate_record(NULL::${fq(req, table)}, ${rec}::text::json))`;
      const prefer = parsePrefer(req.headers['prefer'] as string | undefined);
      const sel = buildSelectList(schema, table, 't', parseSelect(q['select'] as string | undefined));
      const sql = `WITH w AS (UPDATE ${fq(req, table)} t SET ${set} WHERE ${where.join(' AND ')} RETURNING t.*)
        SELECT (SELECT count(*)::int FROM w) AS n, COALESCE((SELECT json_agg(_r) FROM (SELECT ${sel.list} FROM w t) _r), '[]')::text AS body`;
      const res = await withRole(poolerDb, req.auth, async (tx) => (await tx.unsafe(sql, p.values as any[]))[0]!, config.STATEMENT_TIMEOUT_MS);
      reply.header('Content-Range', `*/${res['n']}`);
      if (byId !== undefined && res['n'] === 0) return reply.status(404).send({ error: 'Not Found', message: 'Row not found' });
      if (prefer['return'] === 'minimal') return reply.status(204).send();
      return respondRows(req, reply, res['body'] as string, 200);
    } catch (err) {
      return sendError(reply, err, req.auth?.role);
    }
  };
  server.patch('/v1/:projectId/:table', (req, reply) => update(req, reply));
  server.patch('/v1/:projectId/:table/:id', (req, reply) => update(req, reply, (req.params as any).id));

  // ── Delete ─────────────────────────────────────────────────────────────────
  const remove = async (req: FastifyRequest, reply: FastifyReply, byId?: string) => {
    try {
      const { table, schema } = await tableFor(req);
      const q = { ...(req.query as Q) };
      if (byId !== undefined) {
        if (table.pk.length !== 1) throw new QueryError(400, 'Lookup by id needs a single-column primary key');
        q[table.pk[0]!] = `eq.${byId}`;
      }
      const p = new Params();
      const where = buildWhere(table, 't', q, p);
      if (!where.length) throw new QueryError(400, 'DELETE requires at least one filter', 'Add a filter such as ?id=eq.1');
      const prefer = parsePrefer(req.headers['prefer'] as string | undefined);
      const sel = buildSelectList(schema, table, 't', parseSelect(q['select'] as string | undefined));
      const sql = `WITH w AS (DELETE FROM ${fq(req, table)} t WHERE ${where.join(' AND ')} RETURNING t.*)
        SELECT (SELECT count(*)::int FROM w) AS n, COALESCE((SELECT json_agg(_r) FROM (SELECT ${sel.list} FROM w t) _r), '[]')::text AS body`;
      const res = await withRole(poolerDb, req.auth, async (tx) => (await tx.unsafe(sql, p.values as any[]))[0]!, config.STATEMENT_TIMEOUT_MS);
      reply.header('Content-Range', `*/${res['n']}`);
      if (byId !== undefined && res['n'] === 0) return reply.status(404).send({ error: 'Not Found', message: 'Row not found' });
      if (prefer['return'] === 'representation') return respondRows(req, reply, res['body'] as string, 200);
      return reply.status(204).send();
    } catch (err) {
      return sendError(reply, err, req.auth?.role);
    }
  };
  server.delete('/v1/:projectId/:table', (req, reply) => remove(req, reply));
  server.delete('/v1/:projectId/:table/:id', (req, reply) => remove(req, reply, (req.params as any).id));
}
