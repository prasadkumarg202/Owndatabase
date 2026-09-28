/**
 * Database management routes (Phase 1 + parts of 6).
 *
 * Everything that reads or changes project data runs through the project's
 * own owner role (see lib/project-db.ts), never as the platform superuser.
 * Only a few catalog-wide operations (extensions, realtime triggers, stats)
 * use the platform connection, and those are restricted to allow-lists.
 *
 *   GET    /api/projects/:id/schemas
 *   GET    /api/projects/:id/tables
 *   POST   /api/projects/:id/tables
 *   GET    /api/projects/:id/tables/:table
 *   PATCH  /api/projects/:id/tables/:table
 *   DELETE /api/projects/:id/tables/:table?confirm=true
 *   GET    /api/projects/:id/tables/:table/rows
 *   POST   /api/projects/:id/tables/:table/rows
 *   PATCH  /api/projects/:id/tables/:table/rows
 *   DELETE /api/projects/:id/tables/:table/rows
 *   POST   /api/projects/:id/tables/:table/realtime
 *   POST   /api/projects/:id/execute
 *   POST   /api/projects/:id/explain
 *   GET    /api/projects/:id/query-history
 *   GET    /api/projects/:id/schema-dump
 *   GET    /api/projects/:id/db-functions
 *   GET|POST|DELETE  /api/projects/:id/extensions
 *   GET|POST|DELETE  /api/projects/:id/policies
 *   GET|POST|DELETE  /api/projects/:id/roles
 *   GET    /api/projects/:id/stats
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db, ident, isSafeIdent, literal } from '../lib/db.js';
import { config } from '../config.js';
import { ADMIN_ROLES, WRITE_ROLES, audit, ownerRole, requireProject, userId } from '../lib/access.js';
import { projectDb } from '../lib/project-db.js';
import { redis } from '../lib/redis.js';

// ── Validation helpers ────────────────────────────────────────────────────────

const TYPE_RE = /^[A-Za-z][A-Za-z0-9_ ]*(\([A-Za-z0-9_, ]+\))?(\[\])?$/;
const identSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Names may contain letters, digits and underscores only');
const typeSchema = z.string().max(80).regex(TYPE_RE, 'Unsupported column type');
const exprSchema = z.string().max(2000).refine((s) => !/;|--|\/\*/.test(s), 'Expressions may not contain ; or comments');

const columnSchema = z.object({
  name: identSchema,
  type: typeSchema,
  nullable: z.boolean().default(true),
  default: exprSchema.optional().nullable(),
  primary_key: z.boolean().default(false),
  unique: z.boolean().default(false),
  references: z.object({
    schema: identSchema.optional(),
    table: identSchema,
    column: identSchema.default('id'),
    on_delete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).default('NO ACTION'),
  }).optional().nullable(),
});

const createTableSchema = z.object({
  name: identSchema,
  columns: z.array(columnSchema).min(1).max(200),
  enable_rls: z.boolean().default(false),
  realtime: z.boolean().default(false),
  comment: z.string().max(1000).optional(),
});

function columnDDL(c: z.infer<typeof columnSchema>, schema: string): string {
  const parts = [ident(c.name), c.type];
  if (c.primary_key) parts.push('PRIMARY KEY');
  if (!c.nullable && !c.primary_key) parts.push('NOT NULL');
  if (c.unique && !c.primary_key) parts.push('UNIQUE');
  if (c.default) parts.push(`DEFAULT ${c.default}`);
  if (c.references) {
    const refSchema = c.references.schema === 'auth' ? 'auth' : schema;
    parts.push(`REFERENCES ${ident(refSchema)}.${ident(c.references.table)}(${ident(c.references.column)}) ON DELETE ${c.references.on_delete}`);
  }
  return parts.join(' ');
}

function pgError(reply: FastifyReply, err: unknown, status = 400) {
  const e = err as { message?: string; code?: string; detail?: string; hint?: string; position?: string };
  return reply.status(status).send({
    error: 'Database Error',
    message: e.message ?? String(err),
    code: e.code, detail: e.detail, hint: e.hint, position: e.position,
  });
}

async function schemaChanged(projectId: string, table?: string) {
  await redis.publish('odb:schema-changed', JSON.stringify({ projectId, table })).catch(() => {});
}

function serializeRows(rows: any[]): any[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : v;
    }
    return out;
  });
}

// ── DDL generation for schema dumps (used by MCP resources) ──────────────────

async function tableDDL(schema: string, table: string): Promise<string> {
  const cols = await db`
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = ${schema} AND c.relname = ${table} AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`;
  const cons = await db`
    SELECT conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table} ORDER BY contype DESC, conname`;
  const idx = await db`
    SELECT indexdef FROM pg_indexes WHERE schemaname = ${schema} AND tablename = ${table}
      AND indexname NOT IN (SELECT conname FROM pg_constraint)`;
  const pols = await db`
    SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = ${schema} AND tablename = ${table}`;
  const [rls] = await db`
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table}`;

  const lines = cols.map((c) => `  ${ident(c['name'] as string)} ${c['type']}${c['default'] ? ' DEFAULT ' + c['default'] : ''}${c['not_null'] ? ' NOT NULL' : ''}`);
  for (const k of cons) lines.push(`  CONSTRAINT ${ident(k['conname'] as string)} ${k['def']}`);
  let out = `CREATE TABLE ${ident(schema)}.${ident(table)} (\n${lines.join(',\n')}\n);\n`;
  for (const i of idx) out += `${i['indexdef']};\n`;
  if (rls?.['relrowsecurity']) out += `ALTER TABLE ${ident(schema)}.${ident(table)} ENABLE ROW LEVEL SECURITY;\n`;
  for (const p of pols) {
    out += `CREATE POLICY ${ident(p['policyname'] as string)} ON ${ident(schema)}.${ident(table)} AS ${p['permissive']} FOR ${p['cmd']} TO ${(p['roles'] as string[]).join(', ')}`;
    if (p['qual']) out += ` USING (${p['qual']})`;
    if (p['with_check']) out += ` WITH CHECK (${p['with_check']})`;
    out += ';\n';
  }
  return out;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const databaseRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (summary: string) => ({ schema: { tags: ['database'], summary, security: [{ bearerAuth: [] }] } });

  server.get('/:id/schemas', { ...auth, ...s('List schemas') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    return reply.send({ data: [{ name: p.db_schema, schema_name: p.db_schema, is_default: true }] });
  });

  server.get('/:id/tables', { ...auth, ...s('List tables') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const tables = await db`
      SELECT c.relname AS name, n.nspname AS schema,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
             pg_total_relation_size(c.oid) AS size_bytes,
             GREATEST(c.reltuples, 0)::bigint AS row_estimate,
             COALESCE(st.n_live_tup, 0)::bigint AS row_count,
             c.relrowsecurity AS rls_enabled,
             obj_description(c.oid) AS comment,
             EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname LIKE 'owndatabase_realtime_%') AS realtime_enabled,
             (SELECT count(*)::int FROM pg_policies pp WHERE pp.schemaname = n.nspname AND pp.tablename = c.relname) AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
      WHERE n.nspname = ${p.db_schema} AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`;
    return reply.send({ data: tables.map((t) => ({ ...t, size_bytes: Number(t['size_bytes']), row_estimate: Number(t['row_estimate']), row_count: Number(t['row_count']) })) });
  });

  server.post('/:id/tables', { ...auth, ...s('Create table') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = createTableSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const t = input.data;

    const fq = `${ident(p.db_schema)}.${ident(t.name)}`;
    const ddl = `CREATE TABLE ${fq} (\n  ${t.columns.map((c) => columnDDL(c, p.db_schema)).join(',\n  ')}\n)`;
    const sql = await projectDb(id, p.db_schema);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        if (t.enable_rls) await tx.unsafe(`ALTER TABLE ${fq} ENABLE ROW LEVEL SECURITY`);
        if (t.comment) await tx.unsafe(`COMMENT ON TABLE ${fq} IS ${literal(t.comment)}`);
      });
    } catch (err) {
      return pgError(reply, err);
    }
    if (t.realtime) await db`SELECT control_plane.setup_realtime_trigger(${p.db_schema}, ${t.name})`;
    await schemaChanged(id, t.name);
    await audit(request, 'table.created', { type: 'table', id: t.name, projectId: id }, { ddl });
    return reply.status(201).send({ success: true, table: t.name, schema: p.db_schema, ddl });
  });

  server.get('/:id/tables/:table', { ...auth, ...s('Table structure') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const [rel] = await db`
      SELECT c.oid, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
             EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname LIKE 'owndatabase_realtime_%') AS realtime_enabled
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${p.db_schema} AND c.relname = ${table} AND c.relkind IN ('r','p')`;
    if (!rel) return reply.status(404).send({ error: 'Not Found', message: 'Table not found' });

    const columns = await db`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS is_primary_key,
             (SELECT jsonb_build_object('schema', fn.nspname, 'table', fc.relname, 'column', fa.attname)
                FROM pg_constraint con
                JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
               WHERE con.conrelid = a.attrelid AND con.contype = 'f' AND con.conkey[1] = a.attnum LIMIT 1) AS references,
             col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${rel['oid'] as number} AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`;
    const indexes = await db`SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = ${p.db_schema} AND tablename = ${table} ORDER BY indexname`;
    const constraints = await db`
      SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = ${rel['oid'] as number} ORDER BY conname`;
    const policies = await db`
      SELECT policyname AS name, permissive, roles::text[] AS roles, cmd AS command, qual AS using, with_check
      FROM pg_policies WHERE schemaname = ${p.db_schema} AND tablename = ${table} ORDER BY policyname`;
    return reply.send({
      data: {
        name: table, schema: p.db_schema,
        rls_enabled: rel['rls_enabled'], rls_forced: rel['rls_forced'], realtime_enabled: rel['realtime_enabled'],
        columns: columns.map((c) => ({ ...c, column_name: c['name'], data_type: c['type'], is_nullable: c['nullable'] ? 'YES' : 'NO', column_default: c['default'] })),
        indexes: indexes.map((i) => ({ ...i, indexname: i['name'], indexdef: i['definition'] })),
        constraints, policies,
        ddl: await tableDDL(p.db_schema, table),
      },
    });
  });

  const alterSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('add_column'), column: columnSchema }),
    z.object({ action: z.literal('drop_column'), column_name: identSchema }),
    z.object({ action: z.literal('rename_column'), column_name: identSchema, new_name: identSchema }),
    z.object({ action: z.literal('alter_column_type'), column_name: identSchema, type: typeSchema, using: exprSchema.optional() }),
    z.object({ action: z.literal('set_default'), column_name: identSchema, default: exprSchema.nullable() }),
    z.object({ action: z.literal('set_nullable'), column_name: identSchema, nullable: z.boolean() }),
    z.object({ action: z.literal('rename_table'), new_name: identSchema }),
    z.object({ action: z.literal('add_index'), columns: z.array(identSchema).min(1), unique: z.boolean().default(false), name: identSchema.optional(), method: z.enum(['btree', 'hash', 'gin', 'gist', 'brin']).default('btree') }),
    z.object({ action: z.literal('drop_index'), name: identSchema }),
    z.object({ action: z.literal('enable_rls') }),
    z.object({ action: z.literal('disable_rls') }),
    z.object({ action: z.literal('set_comment'), comment: z.string().max(1000) }),
  ]);

  server.patch('/:id/tables/:table', { ...auth, ...s('Alter table') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    if (!isSafeIdent(table)) return reply.status(400).send({ error: 'Validation Error', message: 'Invalid table name' });

    // Backwards compatibility with the original camelCase payload
    const body: any = { ...(request.body as object) };
    if (body.columnName && !body.column_name) body.column_name = body.columnName;
    if (body.newName && !body.new_name) body.new_name = body.newName;
    if (body.action === 'add_column' && !body.column && body.column_name) body.column = { name: body.column_name, type: body.type };

    const input = alterSchema.safeParse(body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const a = input.data;
    const fq = `${ident(p.db_schema)}.${ident(table)}`;
    let stmt: string;
    switch (a.action) {
      case 'add_column': stmt = `ALTER TABLE ${fq} ADD COLUMN ${columnDDL(a.column, p.db_schema)}`; break;
      case 'drop_column': stmt = `ALTER TABLE ${fq} DROP COLUMN ${ident(a.column_name)}`; break;
      case 'rename_column': stmt = `ALTER TABLE ${fq} RENAME COLUMN ${ident(a.column_name)} TO ${ident(a.new_name)}`; break;
      case 'alter_column_type': stmt = `ALTER TABLE ${fq} ALTER COLUMN ${ident(a.column_name)} TYPE ${a.type}${a.using ? ` USING ${a.using}` : ''}`; break;
      case 'set_default': stmt = a.default === null
        ? `ALTER TABLE ${fq} ALTER COLUMN ${ident(a.column_name)} DROP DEFAULT`
        : `ALTER TABLE ${fq} ALTER COLUMN ${ident(a.column_name)} SET DEFAULT ${a.default}`; break;
      case 'set_nullable': stmt = `ALTER TABLE ${fq} ALTER COLUMN ${ident(a.column_name)} ${a.nullable ? 'DROP' : 'SET'} NOT NULL`; break;
      case 'rename_table': stmt = `ALTER TABLE ${fq} RENAME TO ${ident(a.new_name)}`; break;
      case 'add_index': {
        const name = a.name ?? `${table}_${a.columns.join('_')}_idx`.slice(0, 63);
        stmt = `CREATE ${a.unique ? 'UNIQUE ' : ''}INDEX ${ident(name)} ON ${fq} USING ${a.method} (${a.columns.map(ident).join(', ')})`;
        break;
      }
      case 'drop_index': stmt = `DROP INDEX ${ident(p.db_schema)}.${ident(a.name)}`; break;
      case 'enable_rls': stmt = `ALTER TABLE ${fq} ENABLE ROW LEVEL SECURITY`; break;
      case 'disable_rls': stmt = `ALTER TABLE ${fq} DISABLE ROW LEVEL SECURITY`; break;
      case 'set_comment': stmt = `COMMENT ON TABLE ${fq} IS ${literal(a.comment)}`; break;
    }
    try {
      const sql = await projectDb(id, p.db_schema);
      await sql.unsafe(stmt);
    } catch (err) {
      return pgError(reply, err);
    }
    await schemaChanged(id, table);
    await audit(request, 'table.altered', { type: 'table', id: table, projectId: id }, { statement: stmt });
    return reply.send({ success: true, statement: stmt });
  });

  server.delete('/:id/tables/:table', { ...auth, ...s('Drop table') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    if ((request.query as any).confirm !== 'true') return reply.status(400).send({ error: 'Confirmation Required', message: 'Pass ?confirm=true' });
    if (!isSafeIdent(table)) return reply.status(400).send({ error: 'Validation Error', message: 'Invalid table name' });
    try {
      const sql = await projectDb(id, p.db_schema);
      await sql.unsafe(`DROP TABLE ${ident(p.db_schema)}.${ident(table)} ${(request.query as any).cascade === 'true' ? 'CASCADE' : ''}`);
    } catch (err) {
      return pgError(reply, err);
    }
    await schemaChanged(id, table);
    await audit(request, 'table.dropped', { type: 'table', id: table, projectId: id });
    return reply.send({ success: true });
  });

  // ── Row data (table editor) ───────────────────────────────────────────────

  async function primaryKey(schema: string, table: string): Promise<string[]> {
    const rows = await db`
      SELECT a.attname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND n.nspname = ${schema} AND c.relname = ${table}`;
    return rows.map((r) => r['attname'] as string);
  }

  server.get('/:id/tables/:table/rows', { ...auth, ...s('Browse rows') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    if (!isSafeIdent(table)) return reply.status(400).send({ error: 'Validation Error', message: 'Invalid table name' });
    const q = request.query as { limit?: string; offset?: string; order?: string; direction?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 1000);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const order = q.order && isSafeIdent(q.order) ? `ORDER BY ${ident(q.order)} ${q.direction === 'desc' ? 'DESC' : 'ASC'}` : '';
    const fq = `${ident(p.db_schema)}.${ident(table)}`;
    try {
      const sql = await projectDb(id, p.db_schema);
      const rows = await sql.unsafe(`SELECT * FROM ${fq} ${order} LIMIT ${limit} OFFSET ${offset}`);
      const [{ count }] = await sql.unsafe(`SELECT count(*)::bigint AS count FROM ${fq}`) as any;
      const columns = rows.columns?.map((c: any) => c.name) ?? [];
      return reply.send({ data: serializeRows([...rows]), columns, count: Number(count), limit, offset, primary_key: await primaryKey(p.db_schema, table) });
    } catch (err) {
      return pgError(reply, err);
    }
  });

  server.post('/:id/tables/:table/rows', { ...auth, ...s('Insert row') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const row = request.body as Record<string, unknown>;
    if (!isSafeIdent(table) || !row || typeof row !== 'object' || !Object.keys(row).every(isSafeIdent)) {
      return reply.status(400).send({ error: 'Validation Error', message: 'Invalid table or column names' });
    }
    try {
      const sql = await projectDb(id, p.db_schema);
      // Values arrive as JSON; json_populate_record converts them to the column types
      // (sending them as bind params would let the driver mis-serialise e.g. "true").
      const fq = `${ident(p.db_schema)}.${ident(table)}`;
      const cols = Object.keys(row).map(ident).join(', ');
      const [created] = cols
        ? await sql.unsafe(`INSERT INTO ${fq} (${cols}) SELECT ${cols} FROM json_populate_record(NULL::${fq}, $1::text::json) RETURNING *`, [JSON.stringify(row)])
        : await sql.unsafe(`INSERT INTO ${fq} DEFAULT VALUES RETURNING *`);
      return reply.status(201).send({ data: serializeRows([created])[0] });
    } catch (err) {
      return pgError(reply, err);
    }
  });

  server.patch('/:id/tables/:table/rows', { ...auth, ...s('Update row by primary key') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const body = request.body as { match?: Record<string, unknown>; values?: Record<string, unknown> };
    if (!isSafeIdent(table) || !body?.match || !body?.values || !Object.keys({ ...body.match, ...body.values }).every(isSafeIdent)) {
      return reply.status(400).send({ error: 'Validation Error', message: 'Provide { match: {pk: value}, values: {...} }' });
    }
    const pk = await primaryKey(p.db_schema, table);
    if (!pk.length || !pk.every((k) => k in body.match!)) return reply.status(400).send({ error: 'Validation Error', message: 'match must contain the full primary key' });
    try {
      const sql = await projectDb(id, p.db_schema);
      const fq = `${ident(p.db_schema)}.${ident(table)}`;
      const setCols = Object.keys(body.values);
      const colList = setCols.map(ident).join(', ');
      const where = pk.map((k, i) => `${ident(k)}::text = $${i + 2}::text`).join(' AND ');
      const setSql = setCols.length === 1
        ? `${colList} = (SELECT ${colList} FROM json_populate_record(NULL::${fq}, $1::text::json))`
        : `(${colList}) = (SELECT ${colList} FROM json_populate_record(NULL::${fq}, $1::text::json))`;
      const rows = await sql.unsafe(`UPDATE ${fq} SET ${setSql} WHERE ${where} RETURNING *`,
        [JSON.stringify(body.values), ...pk.map((k) => String(body.match![k]))]);
      if (!rows.length) return reply.status(404).send({ error: 'Not Found', message: 'Row not found' });
      return reply.send({ data: serializeRows([rows[0]])[0] });
    } catch (err) {
      return pgError(reply, err);
    }
  });

  server.delete('/:id/tables/:table/rows', { ...auth, ...s('Delete row by primary key') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const body = request.body as { match?: Record<string, unknown> };
    if (!isSafeIdent(table) || !body?.match) return reply.status(400).send({ error: 'Validation Error', message: 'Provide { match: {pk: value} }' });
    const pk = await primaryKey(p.db_schema, table);
    if (!pk.length || !pk.every((k) => k in body.match!)) return reply.status(400).send({ error: 'Validation Error', message: 'match must contain the full primary key' });
    try {
      const sql = await projectDb(id, p.db_schema);
      const where = pk.map((k, i) => `${ident(k)}::text = $${i + 1}::text`).join(' AND ');
      const rows = await sql.unsafe(`DELETE FROM ${ident(p.db_schema)}.${ident(table)} WHERE ${where} RETURNING *`, pk.map((k) => String(body.match![k])));
      return reply.send({ success: true, deleted: rows.length });
    } catch (err) {
      return pgError(reply, err);
    }
  });

  server.post('/:id/tables/:table/realtime', { ...auth, ...s('Enable/disable realtime for a table') }, async (request, reply) => {
    const { id, table } = request.params as { id: string; table: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const { enabled = true } = (request.body ?? {}) as { enabled?: boolean };
    const [exists] = await db`SELECT 1 FROM pg_tables WHERE schemaname = ${p.db_schema} AND tablename = ${table}`;
    if (!exists) return reply.status(404).send({ error: 'Not Found', message: 'Table not found' });
    if (enabled) await db`SELECT control_plane.setup_realtime_trigger(${p.db_schema}, ${table})`;
    else await db`SELECT control_plane.remove_realtime_trigger(${p.db_schema}, ${table})`;
    await audit(request, enabled ? 'realtime.enabled' : 'realtime.disabled', { type: 'table', id: table, projectId: id });
    return reply.send({ success: true, table, realtime_enabled: enabled });
  });

  // ── SQL editor ────────────────────────────────────────────────────────────

  server.post('/:id/execute', { ...auth, ...s('Execute SQL as the project owner role') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const body = z.object({ query: z.string().min(1).max(200_000), read_only: z.boolean().default(false) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation Error', message: 'query is required' });
    const { query, read_only } = body.data;

    const sql = await projectDb(id, p.db_schema);
    const start = performance.now();
    let error: any = null;
    let results: any[] = [];
    try {
      results = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${config.sqlStatementTimeoutMs}`);
        await tx.unsafe(`SET LOCAL search_path = ${ident(p.db_schema)}, public`);
        if (read_only) await tx.unsafe('SET TRANSACTION READ ONLY');
        const r = await tx.unsafe(query).simple();
        // simple() returns one result for a single statement, or an array of results
        const list = Array.isArray(r) && r.length && Array.isArray(r[0]) ? r : [r];
        return list as any[];
      });
    } catch (e) {
      error = e;
    }
    const duration_ms = Math.round(performance.now() - start);

    const last: any = results[results.length - 1] ?? [];
    const rows = Array.isArray(last) ? [...last] : [];
    const truncated = rows.length > config.sqlMaxRows;
    const data = serializeRows(truncated ? rows.slice(0, config.sqlMaxRows) : rows);
    const columns = last?.columns?.map((c: any) => c.name) ?? (data[0] ? Object.keys(data[0]) : []);

    await db`
      INSERT INTO control_plane.query_history (project_id, user_id, query, duration_ms, row_count, error)
      VALUES (${id}, ${userId(request)}, ${query}, ${duration_ms}, ${error ? 0 : rows.length}, ${error ? String(error.message) : null})`;
    if (!error && /\b(create|alter|drop|rename)\b/i.test(query)) await schemaChanged(id);

    if (error) return pgError(reply, error);
    return reply.send({
      data, columns, duration_ms,
      row_count: last?.count ?? rows.length,
      command: last?.command ?? null,
      statements: results.length,
      truncated,
    });
  });

  server.post('/:id/explain', { ...auth, ...s('EXPLAIN / EXPLAIN ANALYZE a query (always rolled back)') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const body = z.object({ query: z.string().min(1).max(100_000), analyze: z.boolean().default(true) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation Error', message: 'query is required' });
    const q = body.data.query.trim().replace(/;+\s*$/, '');
    if (q.includes(';')) return reply.status(400).send({ error: 'Validation Error', message: 'EXPLAIN accepts a single statement' });

    const sql = await projectDb(id, p.db_schema);
    const ROLLBACK = Symbol('rollback');
    let plan: any = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${config.sqlStatementTimeoutMs}`);
        await tx.unsafe(`SET LOCAL search_path = ${ident(p.db_schema)}, public`);
        const [row] = await tx.unsafe(`EXPLAIN (FORMAT JSON${body.data.analyze ? ', ANALYZE, BUFFERS' : ''}) ${q}`) as any;
        plan = row['QUERY PLAN'];
        throw ROLLBACK; // never persist side effects of EXPLAIN ANALYZE on DML
      });
    } catch (e) {
      if (e !== ROLLBACK) return pgError(reply, e);
    }
    const textPlan: string[] = [];
    const walk = (n: any, depth: number) => {
      textPlan.push(`${'  '.repeat(depth)}-> ${n['Node Type']}${n['Relation Name'] ? ' on ' + n['Relation Name'] : ''}  (cost=${n['Startup Cost']}..${n['Total Cost']} rows=${n['Plan Rows']})${n['Actual Total Time'] !== undefined ? `  (actual time=${n['Actual Total Time']}ms rows=${n['Actual Rows']})` : ''}`);
      for (const c of n['Plans'] ?? []) walk(c, depth + 1);
    };
    if (plan?.[0]?.['Plan']) walk(plan[0]['Plan'], 0);
    return reply.send({
      data: plan, plan: textPlan.join('\n'),
      planning_time_ms: plan?.[0]?.['Planning Time'] ?? null,
      execution_time_ms: plan?.[0]?.['Execution Time'] ?? null,
    });
  });

  server.get('/:id/query-history', { ...auth, ...s('Query history') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const history = await db`
      SELECT id, query, duration_ms, row_count, error, executed_at FROM control_plane.query_history
      WHERE project_id = ${id} AND user_id = ${userId(request)} ORDER BY executed_at DESC LIMIT 50`;
    return reply.send({ data: history });
  });

  server.get('/:id/schema-dump', { ...auth, ...s('DDL for every table in the project') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const tables = await db`SELECT tablename FROM pg_tables WHERE schemaname = ${p.db_schema} ORDER BY tablename`;
    const parts: string[] = [`-- Schema ${p.db_schema}\n`];
    for (const t of tables) parts.push(await tableDDL(p.db_schema, t['tablename'] as string));
    const { table } = request.query as { table?: string };
    if (table) return reply.send({ schema: p.db_schema, ddl: await tableDDL(p.db_schema, table) });
    return reply.send({ schema: p.db_schema, ddl: parts.join('\n') });
  });

  server.get('/:id/db-functions', { ...auth, ...s('Database functions (callable via RPC)') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const rows = await db`
      SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS arguments,
             pg_get_function_result(p.oid) AS returns, l.lanname AS language,
             CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
             p.prosecdef AS security_definer
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = ${p.db_schema} AND p.prokind = 'f' ORDER BY p.proname`;
    return reply.send({ data: rows });
  });

  // ── Extensions ────────────────────────────────────────────────────────────

  server.get('/:id/extensions', { ...auth, ...s('List extensions') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const rows = await db`
      SELECT a.name, a.default_version, a.installed_version, a.comment, (a.installed_version IS NOT NULL) AS installed
      FROM pg_available_extensions a WHERE a.name = ANY(${config.allowedExtensions}) ORDER BY a.name`;
    const available = new Set(rows.map((r) => r['name']));
    const missing = config.allowedExtensions.filter((e) => !available.has(e))
      .map((name) => ({ name, installed: false, available: false, comment: 'Not installed on this PostgreSQL server image' }));
    return reply.send({ data: [...rows.map((r) => ({ ...r, available: true })), ...missing] });
  });

  server.post('/:id/extensions', { ...auth, ...s('Enable extension') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const { name } = (request.body ?? {}) as { name?: string };
    if (!name || !config.allowedExtensions.includes(name)) {
      return reply.status(400).send({ error: 'Validation Error', message: `Extension must be one of: ${config.allowedExtensions.join(', ')}` });
    }
    try {
      await db.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ident(name)} SCHEMA public`);
    } catch (err) {
      return pgError(reply, err);
    }
    await audit(request, 'extension.enabled', { type: 'extension', id: name, projectId: id });
    return reply.status(201).send({ success: true, name, installed: true });
  });

  server.delete('/:id/extensions/:name', { ...auth, ...s('Disable extension') }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!config.allowedExtensions.includes(name) || ['pgcrypto', 'uuid-ossp', 'pg_stat_statements'].includes(name)) {
      return reply.status(400).send({ error: 'Validation Error', message: 'This extension cannot be disabled from the dashboard' });
    }
    try {
      await db.unsafe(`DROP EXTENSION IF EXISTS ${ident(name)}`);
    } catch (err) {
      return pgError(reply, err, 409);
    }
    await audit(request, 'extension.disabled', { type: 'extension', id: name, projectId: id });
    return reply.send({ success: true });
  });

  // ── RLS policies ──────────────────────────────────────────────────────────

  server.get('/:id/policies', { ...auth, ...s('List RLS policies') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const { table } = request.query as { table?: string };
    const rows = await db`
      SELECT tablename AS table, policyname AS name, permissive, roles::text[] AS roles, cmd AS command, qual AS using, with_check
      FROM pg_policies WHERE schemaname = ${p.db_schema} ${table ? db`AND tablename = ${table}` : db``}
      ORDER BY tablename, policyname`;
    return reply.send({ data: rows });
  });

  const policySchema = z.object({
    table: identSchema,
    name: z.string().min(1).max(63).regex(/^[A-Za-z0-9_ -]+$/),
    command: z.enum(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']).default('ALL'),
    roles: z.array(z.enum(['anon', 'authenticated', 'service_role', 'public'])).min(1).default(['authenticated']),
    using: exprSchema.optional().nullable(),
    with_check: exprSchema.optional().nullable(),
    permissive: z.boolean().default(true),
    enable_rls: z.boolean().default(true),
  });

  server.post('/:id/policies', { ...auth, ...s('Create RLS policy') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = policySchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const x = input.data;
    if (x.command === 'INSERT' && x.using) return reply.status(400).send({ error: 'Validation Error', message: 'INSERT policies only support WITH CHECK' });
    const fq = `${ident(p.db_schema)}.${ident(x.table)}`;
    let stmt = `CREATE POLICY ${ident(x.name)} ON ${fq} AS ${x.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${x.command} TO ${x.roles.join(', ')}`;
    if (x.using) stmt += ` USING (${x.using})`;
    if (x.with_check) stmt += ` WITH CHECK (${x.with_check})`;
    try {
      const sql = await projectDb(id, p.db_schema);
      await sql.begin(async (tx) => {
        if (x.enable_rls) await tx.unsafe(`ALTER TABLE ${fq} ENABLE ROW LEVEL SECURITY`);
        await tx.unsafe(stmt);
      });
    } catch (err) {
      return pgError(reply, err);
    }
    await audit(request, 'policy.created', { type: 'policy', id: x.name, projectId: id }, { statement: stmt });
    return reply.status(201).send({ success: true, statement: stmt });
  });

  server.delete('/:id/policies/:table/:name', { ...auth, ...s('Drop RLS policy') }, async (request, reply) => {
    const { id, table, name } = request.params as { id: string; table: string; name: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    try {
      const sql = await projectDb(id, p.db_schema);
      await sql.unsafe(`DROP POLICY ${ident(name)} ON ${ident(p.db_schema)}.${ident(table)}`);
    } catch (err) {
      return pgError(reply, err);
    }
    await audit(request, 'policy.dropped', { type: 'policy', id: name, projectId: id });
    return reply.send({ success: true });
  });

  // ── Database roles ────────────────────────────────────────────────────────

  server.get('/:id/roles', { ...auth, ...s('List database roles') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as any).id);
    if (!p) return;
    const prefix = `${p.db_schema}_`;
    const rows = await db`
      SELECT rolname AS name, rolcanlogin AS can_login, rolbypassrls AS bypass_rls, rolconnlimit AS connection_limit,
             CASE WHEN rolname = ${ownerRole(p.db_schema)} THEN 'owner'
                  WHEN rolname IN ('anon','authenticated','service_role') THEN 'system'
                  ELSE 'custom' END AS kind
      FROM pg_roles
      WHERE rolname IN ('anon','authenticated','service_role') OR rolname LIKE ${prefix + '%'}
      ORDER BY kind, rolname`;
    return reply.send({ data: rows });
  });

  server.post('/:id/roles', { ...auth, ...s('Create a custom database role') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const input = z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Role names: lowercase letters, digits, underscores'),
      can_login: z.boolean().default(false),
      password: z.string().min(12).max(128).optional(),
      grant_select: z.boolean().default(true),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const r = input.data;
    if (r.can_login && !r.password) return reply.status(400).send({ error: 'Validation Error', message: 'Login roles need a password (min 12 chars)' });
    const role = `${p.db_schema}_${r.name}`.slice(0, 63);
    if (role === ownerRole(p.db_schema)) return reply.status(400).send({ error: 'Validation Error', message: 'Reserved role name' });
    const s = ident(p.db_schema);
    try {
      await db.begin(async (tx) => {
        await tx.unsafe(`CREATE ROLE ${ident(role)} ${r.can_login ? `LOGIN PASSWORD ${literal(r.password!)}` : 'NOLOGIN'} NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
        await tx.unsafe(`GRANT USAGE ON SCHEMA ${s} TO ${ident(role)}`);
        await tx.unsafe(`ALTER ROLE ${ident(role)} SET search_path = ${s}, public`);
        if (r.grant_select) {
          await tx.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${ident(role)}`);
          await tx.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(ownerRole(p.db_schema))} IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${ident(role)}`);
        }
      });
    } catch (err) {
      return pgError(reply, err, 409);
    }
    await audit(request, 'role.created', { type: 'db_role', id: role, projectId: id });
    return reply.status(201).send({ success: true, name: role });
  });

  server.delete('/:id/roles/:name', { ...auth, ...s('Drop a custom database role') }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!name.startsWith(`${p.db_schema}_`) || name === ownerRole(p.db_schema)) {
      return reply.status(400).send({ error: 'Validation Error', message: 'Only custom project roles can be dropped' });
    }
    try {
      await db.begin(async (tx) => {
        await tx.unsafe(`DROP OWNED BY ${ident(name)}`);
        await tx.unsafe(`DROP ROLE ${ident(name)}`);
      });
    } catch (err) {
      return pgError(reply, err, 409);
    }
    await audit(request, 'role.dropped', { type: 'db_role', id: name, projectId: id });
    return reply.send({ success: true });
  });

  // ── Statistics (Phase 6) ──────────────────────────────────────────────────

  server.get('/:id/stats', { ...auth, ...s('Database statistics') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const owner = ownerRole(p.db_schema);

    const [size] = await db`
      SELECT pg_database_size(current_database()) AS database_bytes,
             COALESCE((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = ${p.db_schema} AND c.relkind IN ('r','m','i','t')), 0) AS schema_bytes`;
    const connections = await db`
      SELECT COALESCE(state, 'background') AS state, count(*)::int AS count
      FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 2 DESC`;
    const [settings] = await db`SELECT current_setting('max_connections')::int AS max_connections`;
    const [cache] = await db`
      SELECT CASE WHEN sum(heap_blks_hit + heap_blks_read) = 0 THEN 1
                  ELSE round(sum(heap_blks_hit)::numeric / sum(heap_blks_hit + heap_blks_read), 4) END AS ratio
      FROM pg_statio_user_tables WHERE schemaname = ${p.db_schema}`;
    const [xact] = await db`
      SELECT xact_commit, xact_rollback, deadlocks, temp_bytes, blks_hit, blks_read
      FROM pg_stat_database WHERE datname = current_database()`;
    const tables = await db`
      SELECT relname AS table, n_live_tup AS live_rows, n_dead_tup AS dead_rows,
             seq_scan, idx_scan, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
             autovacuum_count, vacuum_count,
             pg_total_relation_size(relid) AS total_bytes
      FROM pg_stat_user_tables WHERE schemaname = ${p.db_schema}
      ORDER BY pg_total_relation_size(relid) DESC LIMIT 25`;

    let slow_queries: any[] = [];
    try {
      slow_queries = await db`
        SELECT left(s.query, 500) AS query, s.calls, round(s.total_exec_time::numeric, 2) AS total_ms,
               round(s.mean_exec_time::numeric, 2) AS mean_ms, s.rows
        FROM pg_stat_statements s
        JOIN pg_roles r ON r.oid = s.userid
        WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND (r.rolname = ${owner} OR s.query ILIKE ${'%' + p.db_schema + '%'})
          AND s.query !~* '(password|^\\s*(alter|create|drop|grant|revoke)\\s+role)'
        ORDER BY s.mean_exec_time DESC LIMIT 20`;
    } catch { /* pg_stat_statements not loaded */ }

    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return reply.send({
      data: {
        database_bytes: num(size!['database_bytes']),
        schema_bytes: num(size!['schema_bytes']),
        size: `${(Number(size!['schema_bytes']) / 1024 / 1024).toFixed(2)} MB`,
        connections: connections.reduce((a, c) => a + (c['count'] as number), 0),
        connections_by_state: connections,
        max_connections: settings!['max_connections'],
        cache_hit_ratio: Number(cache?.['ratio'] ?? 1),
        cacheHitRatio: Number(cache?.['ratio'] ?? 1),
        transactions: { commits: num(xact?.['xact_commit']), rollbacks: num(xact?.['xact_rollback']), deadlocks: num(xact?.['deadlocks']) },
        tables: tables.map((t) => ({ ...t, live_rows: num(t['live_rows']), dead_rows: num(t['dead_rows']), seq_scan: num(t['seq_scan']), idx_scan: num(t['idx_scan']), total_bytes: num(t['total_bytes']) })),
        slow_queries: slow_queries.map((q) => ({ ...q, calls: num(q['calls']), rows: num(q['rows']), total_ms: num(q['total_ms']), mean_ms: num(q['mean_ms']) })),
      },
    });
  });
};
