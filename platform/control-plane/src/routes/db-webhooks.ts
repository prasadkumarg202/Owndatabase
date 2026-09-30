/**
 * Database webhooks (table row changes → HTTP).
 *
 *   GET    /api/projects/:id/webhooks
 *   POST   /api/projects/:id/webhooks                       { name, table, events, url, method?, headers?, secret?, timeout_ms?, enabled? }
 *   PATCH  /api/projects/:id/webhooks/:hookId               (same fields, partial)
 *   DELETE /api/projects/:id/webhooks/:hookId
 *   GET    /api/projects/:id/webhooks/:hookId/deliveries    ?status=
 *   POST   /api/projects/:id/webhooks/:hookId/deliveries/:eventId/retry
 *
 * A trigger (control_plane.db_webhook_fire) writes each change to an outbox;
 * the queue worker delivers it (see workers/queue-worker/src/db-webhooks.ts).
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db, ident } from '../lib/db.js';
import { ADMIN_ROLES, audit, requireProject, userId } from '../lib/access.js';
import { randomUUID } from 'node:crypto';
import { sealBytes } from '../lib/vault.js';

const s = (summary: string) => ({ schema: { tags: ['webhooks'], summary, security: [{ bearerAuth: [] }] } });
const identRe = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const uuidRe = /^[0-9a-f-]{36}$/i;

const hookSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_ .-]+$/, 'Name may contain letters, digits, spaces, _ . -'),
  table: z.string().regex(identRe, 'Invalid table name'),
  events: z.array(z.enum(['insert', 'update', 'delete'])).min(1).transform((e) => [...new Set(e)]),
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'url must be http(s)'),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(2000)).refine((h) => Object.keys(h).length <= 20, 'At most 20 headers').default({}),
  secret: z.string().min(8).max(200).nullable().optional(),
  timeout_ms: z.number().int().min(500).max(30_000).default(5000),
  enabled: z.boolean().default(true),
});

const triggerName = (hookId: string) => `odb_webhook_${hookId.replace(/-/g, '').slice(0, 16)}`;

async function installTrigger(schema: string, table: string, hookId: string) {
  await db.unsafe(`DROP TRIGGER IF EXISTS ${ident(triggerName(hookId))} ON ${ident(schema)}.${ident(table)}`);
  await db.unsafe(`CREATE TRIGGER ${ident(triggerName(hookId))}
    AFTER INSERT OR UPDATE OR DELETE ON ${ident(schema)}.${ident(table)}
    FOR EACH ROW EXECUTE FUNCTION control_plane.db_webhook_fire('${hookId}')`);
}

async function dropTrigger(schema: string, table: string, hookId: string) {
  const [t] = await db`SELECT 1 FROM pg_tables WHERE schemaname = ${schema} AND tablename = ${table}`;
  if (t) await db.unsafe(`DROP TRIGGER IF EXISTS ${ident(triggerName(hookId))} ON ${ident(schema)}.${ident(table)}`);
}

function publicHook(h: Record<string, any>) {
  const { secret_encrypted, ...rest } = h;
  return { ...rest, has_secret: !!secret_encrypted };
}

export const dbWebhookRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };

  server.get('/:id/webhooks', { ...auth, ...s('List database webhooks') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id);
    if (!p) return;
    const rows = await db`
      SELECT w.*,
        EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = w.schema_name AND t.tablename = w.table_name) AS table_exists,
        EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = w.schema_name AND c.relname = w.table_name
                  AND tg.tgname = 'odb_webhook_' || left(replace(w.id::text, '-', ''), 16)) AS trigger_installed,
        (SELECT count(*)::int FROM control_plane.db_webhook_events e WHERE e.webhook_id = w.id AND e.status IN ('pending', 'sending')) AS pending,
        (SELECT count(*)::int FROM control_plane.db_webhook_events e WHERE e.webhook_id = w.id AND e.status = 'failed' AND e.created_at > NOW() - INTERVAL '24 hours') AS failed_24h,
        (SELECT max(e.delivered_at) FROM control_plane.db_webhook_events e WHERE e.webhook_id = w.id) AS last_delivered_at
      FROM control_plane.db_webhooks w WHERE w.project_id = ${p.id} ORDER BY w.created_at`;
    return reply.send({ data: rows.map(publicHook) });
  });

  server.post('/:id/webhooks', { ...auth, ...s('Create a database webhook') }, async (request, reply) => {
    const p = await requireProject(request, reply, (request.params as { id: string }).id, ADMIN_ROLES);
    if (!p) return;
    const input = hookSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const h = input.data;
    const [t] = await db`SELECT 1 FROM pg_tables WHERE schemaname = ${p.db_schema} AND tablename = ${h.table}`;
    if (!t) return reply.status(404).send({ error: 'Not Found', message: `Table ${h.table} does not exist` });
    const [dup] = await db`SELECT 1 FROM control_plane.db_webhooks WHERE project_id = ${p.id} AND name = ${h.name}`;
    if (dup) return reply.status(409).send({ error: 'Conflict', message: 'A webhook with that name already exists' });

    const hookId = randomUUID();
    const sealed = h.secret ? await sealBytes(p.id, `db_webhook:${hookId}`, h.secret) : null;
    const hook = await db.begin(async (sql) => {
      const [row] = await sql`
        INSERT INTO control_plane.db_webhooks (id, project_id, name, schema_name, table_name, events, url, http_method, headers, secret_encrypted, timeout_ms, enabled, created_by)
        VALUES (${hookId}, ${p.id}, ${h.name}, ${p.db_schema}, ${h.table}, ${h.events}, ${h.url}, ${h.method}, ${sql.json(h.headers)},
                ${sealed}, ${h.timeout_ms}, ${h.enabled}, ${userId(request)})
        RETURNING *`;
      return row!;
    });
    try {
      await installTrigger(p.db_schema, h.table, hook['id'] as string);
    } catch (err) {
      await db`DELETE FROM control_plane.db_webhooks WHERE id = ${hook['id'] as string}`;
      throw err;
    }
    await audit(request, 'webhook.created', { type: 'db_webhook', id: hook['id'] as string, projectId: p.id }, { table: h.table, events: h.events });
    return reply.status(201).send(publicHook(hook));
  });

  server.patch('/:id/webhooks/:hookId', { ...auth, ...s('Update a database webhook') }, async (request, reply) => {
    const { id, hookId } = request.params as { id: string; hookId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!uuidRe.test(hookId)) return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
    const [cur] = await db`SELECT * FROM control_plane.db_webhooks WHERE id = ${hookId} AND project_id = ${p.id}`;
    if (!cur) return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
    const input = hookSchema.partial().safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const b = input.data;
    // .partial() keeps defaults; only apply keys the caller actually sent
    const sent = new Set(Object.keys((request.body ?? {}) as object));
    const pick = <K extends keyof typeof b>(k: K, col: string) => (sent.has(k as string) ? b[k] : cur[col]);

    const table = (pick('table', 'table_name') as string);
    if (table !== cur['table_name']) {
      const [t] = await db`SELECT 1 FROM pg_tables WHERE schemaname = ${p.db_schema} AND tablename = ${table}`;
      if (!t) return reply.status(404).send({ error: 'Not Found', message: `Table ${table} does not exist` });
    }
    const secret = sent.has('secret') ? (b.secret ? await sealBytes(p.id, `db_webhook:${cur['id']}`, b.secret) : null) : cur['secret_encrypted'];
    const [row] = await db`
      UPDATE control_plane.db_webhooks SET
        name = ${pick('name', 'name') as string}, table_name = ${table}, events = ${pick('events', 'events') as string[]},
        url = ${pick('url', 'url') as string}, http_method = ${(sent.has('method') ? b.method : cur['http_method']) as string},
        headers = ${db.json((pick('headers', 'headers') ?? {}) as any)}, secret_encrypted = ${secret},
        timeout_ms = ${pick('timeout_ms', 'timeout_ms') as number}, enabled = ${pick('enabled', 'enabled') as boolean}, updated_at = NOW()
      WHERE id = ${hookId} RETURNING *`;
    if (table !== cur['table_name']) await dropTrigger(p.db_schema, cur['table_name'] as string, hookId);
    // (re)install: also repairs a webhook whose table was dropped and recreated
    const [exists] = await db`SELECT 1 FROM pg_tables WHERE schemaname = ${p.db_schema} AND tablename = ${table}`;
    if (exists) await installTrigger(p.db_schema, table, hookId);
    await audit(request, 'webhook.updated', { type: 'db_webhook', id: hookId, projectId: p.id }, { fields: [...sent] });
    return reply.send(publicHook(row!));
  });

  server.delete('/:id/webhooks/:hookId', { ...auth, ...s('Delete a database webhook') }, async (request, reply) => {
    const { id, hookId } = request.params as { id: string; hookId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!uuidRe.test(hookId)) return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
    const [cur] = await db`SELECT * FROM control_plane.db_webhooks WHERE id = ${hookId} AND project_id = ${p.id}`;
    if (!cur) return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
    await dropTrigger(p.db_schema, cur['table_name'] as string, hookId);
    await db`DELETE FROM control_plane.db_webhooks WHERE id = ${hookId}`;
    await audit(request, 'webhook.deleted', { type: 'db_webhook', id: hookId, projectId: p.id });
    return reply.send({ success: true });
  });

  server.get('/:id/webhooks/:hookId/deliveries', { ...auth, ...s('Recent webhook deliveries') }, async (request, reply) => {
    const { id, hookId } = request.params as { id: string; hookId: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    if (!uuidRe.test(hookId)) return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
    const { status, limit = '50' } = request.query as { status?: string; limit?: string };
    const rows = await db`
      SELECT id, status, attempts, last_status_code, last_error, duration_ms, payload, created_at, delivered_at, next_attempt_at
      FROM control_plane.db_webhook_events
      WHERE webhook_id = ${hookId} AND project_id = ${p.id} ${status ? db`AND status = ${status}` : db``}
      ORDER BY id DESC LIMIT ${Math.min(Number(limit) || 50, 200)}`;
    return reply.send({ data: rows });
  });

  server.post('/:id/webhooks/:hookId/deliveries/:eventId/retry', { ...auth, ...s('Retry a webhook delivery') }, async (request, reply) => {
    const { id, hookId, eventId } = request.params as { id: string; hookId: string; eventId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!uuidRe.test(hookId) || !/^\d+$/.test(eventId)) return reply.status(404).send({ error: 'Not Found', message: 'Delivery not found' });
    const [e] = await db`
      UPDATE control_plane.db_webhook_events SET status = 'pending', next_attempt_at = NOW(), attempts = 0
      WHERE id = ${eventId} AND webhook_id = ${hookId} AND project_id = ${p.id} AND status IN ('failed', 'delivered') RETURNING id`;
    if (!e) return reply.status(404).send({ error: 'Not Found', message: 'Delivery not found or still in progress' });
    await db`SELECT pg_notify('odb_db_webhooks', ${hookId})`;
    return reply.send({ success: true });
  });
};
