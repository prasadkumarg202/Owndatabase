/**
 * Database webhook dispatcher.
 *
 * Delivers control_plane.db_webhook_events (the outbox written by the
 * control_plane.db_webhook_fire trigger). Woken by NOTIFY odb_db_webhooks
 * and by a 5 s poll. Events are claimed with FOR UPDATE SKIP LOCKED, so any
 * number of workers can run; a claim is a 2-minute lease, so events held by
 * a crashed worker are picked up again.
 *
 * Request: POST (or the webhook's method) with JSON
 *   { type, table, schema, record, old_record, commit_timestamp }
 * headers x-odb-webhook-id, x-odb-event-id, the webhook's own headers and,
 * with a secret, x-odb-timestamp + x-odb-signature: sha256=HMAC(secret, `${ts}.${body}`).
 * 2xx = delivered; otherwise retried after 10s, 30s, 2m, 10m, 30m, then failed.
 */
import type postgres from 'postgres';
import type { Logger } from 'pino';
import { createHmac } from 'node:crypto';
import { Counter } from 'prom-client';
import { assertPublicUrl } from './net-guard.js';
import type { VaultClient } from './vault-client.js';

const BACKOFF_S = [10, 30, 120, 600, 1800];
const MAX_ATTEMPTS = BACKOFF_S.length + 1;
const BATCH = 20;

const deliveries = new Counter({ name: 'owndatabase_db_webhook_deliveries_total', help: 'Database webhook delivery attempts', labelNames: ['result'] });

export function startDbWebhookDispatcher(sql: postgres.Sql<any>, logger: Logger, vault: VaultClient) {
  let draining = false;
  let again = false;
  let stopped = false;

  async function deliver(e: Record<string, any>, hook: Record<string, any> | undefined) {
    const started = Date.now();
    let code: number | null = null;
    let error: string | null = null;
    if (!hook || !hook['enabled']) {
      error = hook ? 'Webhook is disabled' : 'Webhook was deleted';
    } else {
      try {
        await assertPublicUrl(hook['url']);
        const body = JSON.stringify(e['payload']);
        const headers: Record<string, string> = {
          'user-agent': 'OwnDatabase-Webhooks/1.0',
          'content-type': 'application/json',
          'x-odb-webhook-id': String(hook['id']),
          'x-odb-event-id': String(e['id']),
          ...(hook['headers'] ?? {}),
        };
        // signing secret from the vault (docs/vault.md); if it can't be read the delivery fails and is retried, never sent unsigned
        const secret = hook['secret_encrypted'] ? (await vault.reveal(String(hook['project_id']), 'db_webhook', String(hook['id'])))['secret'] : null;
        if (hook['secret_encrypted'] && !secret) throw new Error('Webhook signing secret is unavailable');
        if (secret) {
          const ts = Math.floor(Date.now() / 1000);
          headers['x-odb-timestamp'] = String(ts);
          headers['x-odb-signature'] = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
        }
        const res = await fetch(hook['url'], {
          method: hook['http_method'] ?? 'POST', headers, body, redirect: 'manual',
          signal: AbortSignal.timeout(Number(hook['timeout_ms']) || 5000),
        });
        code = res.status;
        await res.arrayBuffer().catch(() => undefined);
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (err) {
        error = (err as Error).message.slice(0, 500);
      }
    }
    const ms = Date.now() - started;
    const permanent = !hook || !hook['enabled'];
    if (!error) {
      deliveries.inc({ result: 'delivered' });
      await sql`UPDATE control_plane.db_webhook_events SET status = 'delivered', delivered_at = NOW(), last_status_code = ${code},
                last_error = NULL, duration_ms = ${ms} WHERE id = ${e['id']}`;
    } else if (permanent || e['attempts'] >= MAX_ATTEMPTS) {
      deliveries.inc({ result: 'failed' });
      await sql`UPDATE control_plane.db_webhook_events SET status = 'failed', last_status_code = ${code}, last_error = ${error},
                duration_ms = ${ms} WHERE id = ${e['id']}`;
      logger.warn({ eventId: e['id'], webhookId: e['webhook_id'], error }, 'Database webhook failed permanently');
    } else {
      deliveries.inc({ result: 'retry' });
      const wait = BACKOFF_S[Math.min(e['attempts'] - 1, BACKOFF_S.length - 1)]!;
      await sql`UPDATE control_plane.db_webhook_events SET status = 'pending', next_attempt_at = NOW() + make_interval(secs => ${wait}),
                last_status_code = ${code}, last_error = ${error}, duration_ms = ${ms} WHERE id = ${e['id']}`;
    }
  }

  async function drain() {
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        // pending and due, or 'sending' whose lease ran out (worker died mid-delivery)
        const batch = await sql`
          UPDATE control_plane.db_webhook_events e
          SET status = 'sending', attempts = e.attempts + 1, next_attempt_at = NOW() + INTERVAL '2 minutes'
          WHERE e.id IN (
            SELECT id FROM control_plane.db_webhook_events
            WHERE status IN ('pending', 'sending') AND next_attempt_at <= NOW()
            ORDER BY next_attempt_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING e.id, e.webhook_id, e.payload, e.attempts`;
        if (!batch.length) break;
        const ids = [...new Set(batch.map((e) => e['webhook_id'] as string))];
        const hooks = await sql`SELECT id, project_id, url, http_method, headers, secret_encrypted, timeout_ms, enabled FROM control_plane.db_webhooks WHERE id = ANY(${ids})`;
        const byId = new Map(hooks.map((h) => [h['id'] as string, h]));
        await Promise.all(batch.map((e) => deliver(e, byId.get(e['webhook_id'] as string))));
        if (batch.length === BATCH) again = true;
      } while (again && !stopped);
    } catch (err) {
      // 42P01: the outbox table does not exist yet (control-api has not run migration 012)
      if ((err as { code?: string }).code === '42P01') logger.debug('Waiting for the db_webhook_events migration');
      else logger.error({ err: (err as Error).message }, 'Database webhook dispatcher error');
    } finally {
      draining = false;
    }
  }

  const kick = () => { if (!stopped) void drain(); };
  sql.listen('odb_db_webhooks', kick).catch((err) => logger.warn({ err: err.message }, 'LISTEN odb_db_webhooks failed; polling only'));
  const poll = setInterval(kick, 5000);
  // keep the outbox small: delivered events for 7 days, failed ones for 30
  const cleanup = setInterval(() => {
    sql`DELETE FROM control_plane.db_webhook_events
        WHERE (status = 'delivered' AND created_at < NOW() - INTERVAL '7 days')
           OR (status = 'failed' AND created_at < NOW() - INTERVAL '30 days')`.catch(() => {});
  }, 3600_000);
  kick();
  logger.info('Database webhook dispatcher started');

  return () => { stopped = true; clearInterval(poll); clearInterval(cleanup); };
}
