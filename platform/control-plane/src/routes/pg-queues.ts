/**
 * Postgres-native queues (odb_queue, migration 016) — dashboard / API management.
 *
 *   GET    /api/projects/:id/pg-queues                      queues with metrics
 *   POST   /api/projects/:id/pg-queues                      { name } create (also installs the API wrappers)
 *   DELETE /api/projects/:id/pg-queues/:name                drop the queue and its archive
 *   POST   /api/projects/:id/pg-queues/:name/messages       { message, delay_seconds? } send
 *   GET    /api/projects/:id/pg-queues/:name/messages       peek (does not change visibility)
 *   POST   /api/projects/:id/pg-queues/:name/purge          delete every message
 *
 * Everything runs on the project's owner-role connection. Applications use
 * the queue_* functions through RPC (POST /rest/v1/:project/rpc/queue_send …),
 * which are executable by service_role only until the project grants more.
 */
import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { redis } from '../lib/redis.js';
import { ADMIN_ROLES, WRITE_ROLES, audit, requireProject } from '../lib/access.js';
import { projectDb } from '../lib/project-db.js';

const s = (summary: string) => ({ schema: { tags: ['queues'], summary, security: [{ bearerAuth: [] }] } });
const nameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'Queue names use a-z, 0-9 and _, starting with a letter (max 48)');

// RPC wrappers in the project schema (SECURITY INVOKER: the caller's grants apply)
const WRAPPERS = `
CREATE OR REPLACE FUNCTION queue_send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0) RETURNS bigint
  LANGUAGE sql AS $$ SELECT odb_queue.send(queue_name, message, sleep_seconds) $$;
CREATE OR REPLACE FUNCTION queue_send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0) RETURNS SETOF bigint
  LANGUAGE sql AS $$ SELECT odb_queue.send_batch(queue_name, messages, sleep_seconds) $$;
CREATE OR REPLACE FUNCTION queue_read(queue_name text, sleep_seconds integer DEFAULT 30, n integer DEFAULT 1)
  RETURNS TABLE (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
  LANGUAGE sql AS $$ SELECT * FROM odb_queue.read(queue_name, sleep_seconds, n) $$;
CREATE OR REPLACE FUNCTION queue_pop(queue_name text)
  RETURNS TABLE (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
  LANGUAGE sql AS $$ SELECT * FROM odb_queue.pop(queue_name) $$;
CREATE OR REPLACE FUNCTION queue_archive(queue_name text, message_id bigint) RETURNS boolean
  LANGUAGE sql AS $$ SELECT odb_queue.archive(queue_name, message_id) $$;
CREATE OR REPLACE FUNCTION queue_delete(queue_name text, message_id bigint) RETURNS boolean
  LANGUAGE sql AS $$ SELECT odb_queue.delete(queue_name, message_id) $$;
CREATE OR REPLACE FUNCTION queue_set_vt(queue_name text, message_id bigint, sleep_seconds integer) RETURNS boolean
  LANGUAGE sql AS $$ SELECT odb_queue.set_vt(queue_name, message_id, sleep_seconds) $$;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['queue_send(text,jsonb,integer)', 'queue_send_batch(text,jsonb[],integer)', 'queue_read(text,integer,integer)',
                           'queue_pop(text)', 'queue_archive(text,bigint)', 'queue_delete(text,bigint)', 'queue_set_vt(text,bigint,integer)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO service_role';
  END LOOP;
END $$;`;

function pgFail(reply: FastifyReply, err: unknown) {
  const e = err as { code?: string; message?: string };
  const status = e.code === '42P01' ? 404 : e.code === '22023' ? 400 : 400;
  return reply.status(status).send({ error: status === 404 ? 'Not Found' : 'Bad Request', message: e.message ?? String(err) });
}

export const pgQueueRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const schemaChanged = (projectId: string) => redis.publish('odb:schema-changed', JSON.stringify({ projectId })).catch(() => {});

  server.get('/:id/pg-queues', { ...auth, ...s('List Postgres queues') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id);
    if (!p) return;
    const sql = await projectDb(p.id, p.db_schema);
    const queues = await sql`SELECT queue_name FROM odb_queue.list_queues()`;
    const data = [];
    for (const q of queues) {
      const [m] = await sql`SELECT * FROM odb_queue.metrics(${q['queue_name'] as string})`;
      data.push({ ...m, queue_length: Number(m?.['queue_length'] ?? 0), visible: Number(m?.['visible'] ?? 0), total_messages: Number(m?.['total_messages'] ?? 0), archived: Number(m?.['archived'] ?? 0) });
    }
    return reply.send({ data });
  });

  server.post('/:id/pg-queues', { ...auth, ...s('Create a Postgres queue') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, WRITE_ROLES);
    if (!p) return;
    const input = z.object({ name: nameSchema }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const sql = await projectDb(p.id, p.db_schema);
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT odb_queue."create"(${input.data.name})`;
        await tx.unsafe(WRAPPERS);
      });
    } catch (err) { return pgFail(reply, err); }
    await schemaChanged(p.id);
    await audit(request, 'queue.created', { type: 'pg_queue', id: input.data.name, projectId: p.id });
    return reply.status(201).send({ name: input.data.name });
  });

  server.delete('/:id/pg-queues/:name', { ...auth, ...s('Drop a Postgres queue') }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!nameSchema.safeParse(name).success) return reply.status(404).send({ error: 'Not Found', message: 'Queue not found' });
    const sql = await projectDb(p.id, p.db_schema);
    try { await sql`SELECT odb_queue."drop"(${name})`; } catch (err) { return pgFail(reply, err); }
    await schemaChanged(p.id);
    await audit(request, 'queue.dropped', { type: 'pg_queue', id: name, projectId: p.id });
    return reply.send({ success: true });
  });

  server.post('/:id/pg-queues/:name/messages', { ...auth, ...s('Send a message') }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = z.object({ message: z.record(z.unknown()).or(z.array(z.unknown())), delay_seconds: z.number().int().min(0).max(86400 * 7).default(0) }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'message must be a JSON object or array' });
    const sql = await projectDb(p.id, p.db_schema);
    try {
      const [r] = await sql`SELECT odb_queue.send(${name}, ${sql.json(input.data.message as any)}, ${input.data.delay_seconds}) AS msg_id`;
      return reply.status(201).send({ msg_id: Number(r!['msg_id']) });
    } catch (err) { return pgFail(reply, err); }
  });

  server.get('/:id/pg-queues/:name/messages', { ...auth, ...s('Peek at messages (visibility unchanged)') }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const { archived, limit = '50' } = request.query as { archived?: string; limit?: string };
    const sql = await projectDb(p.id, p.db_schema);
    try {
      const [t] = await sql`SELECT odb_queue._table(${name}, ${archived === 'true'}) AS t`;
      const rows = await sql.unsafe(`SELECT * FROM ${t!['t']} ORDER BY msg_id DESC LIMIT ${Math.min(Number(limit) || 50, 200)}`);
      return reply.send({ data: rows.map((r) => ({ ...r, msg_id: Number(r['msg_id']) })) });
    } catch (err) { return pgFail(reply, err); }
  });

  server.post('/:id/pg-queues/:name/purge', { ...auth, ...s('Delete every message in a queue') }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const sql = await projectDb(p.id, p.db_schema);
    try {
      const [r] = await sql`SELECT odb_queue.purge(${name}) AS n`;
      await audit(request, 'queue.purged', { type: 'pg_queue', id: name, projectId: p.id });
      return reply.send({ deleted: Number(r!['n']) });
    } catch (err) { return pgFail(reply, err); }
  });
};
