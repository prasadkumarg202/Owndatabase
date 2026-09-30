/**
 * Log drains (docs/log-drains.md): every few seconds, forwards each project's new log events to its
 * drains. Sources:
 *   audit      control_plane.audit_logs      (dashboard / API changes)
 *   auth       auth.auth_audit_log           (sign-ins, sign-ups, MFA, ...)
 *   functions  control_plane.function_logs   (invocations, console output, errors)
 *   platform   Loki lines of the API services that mention the project (requests, errors)
 * A cursor per source makes delivery at-least-once and in order. Failed batches are retried with
 * backoff; after 50 failures in a row the drain is switched off (the dashboard shows why).
 */
import type postgres from 'postgres';
import type { Logger } from 'pino';
import { assertPublicUrl } from './net-guard.js';
import { sendToDrain, type DrainEvent } from './log-drain.js';
import type { VaultClient } from './vault-client.js';

const TICK_MS = Number(process.env['LOG_DRAIN_INTERVAL_MS'] ?? 5000);
const BATCH = 500;
const LAG = "INTERVAL '2 seconds'";        // rows still being committed are picked up next time
const MAX_FAILURES = 50;
const PLATFORM_SERVICES = 'api-service|auth-service|storage-api|realtime-service|functions-runtime|control-api|caddy';

const pinoLevel = (n: unknown) => (typeof n === 'number' ? (n >= 50 ? 'error' : n >= 40 ? 'warn' : n <= 20 ? 'debug' : 'info') : 'info');

export function startLogDrains(sql: postgres.Sql<any>, logger: Logger, vault: VaultClient, lokiUrl: string | undefined) {
  let running = false;

  async function collect(d: Record<string, any>): Promise<{ events: DrainEvent[]; cursor: Record<string, string> }> {
    const pid = d['project_id'] as string;
    const cursor: Record<string, string> = { ...(d['cursor'] ?? {}) };
    const since = (src: string) => cursor[src] ?? new Date(0).toISOString();
    const events: DrainEvent[] = [];
    const sources: string[] = d['sources'] ?? [];

    if (sources.includes('audit')) {
      const rows = await sql`
        SELECT "timestamp"::text AS ts, event_type, actor_id, ip_address, metadata FROM control_plane.audit_logs
        WHERE project_id = ${pid} AND "timestamp" > ${since('audit')}::timestamptz AND "timestamp" < NOW() - ${sql.unsafe(LAG)}
        ORDER BY "timestamp" LIMIT ${BATCH}`;
      for (const r of rows) events.push({ timestamp: new Date(r['ts']).toISOString(), source: 'audit', event: r['event_type'], level: 'info',
        message: r['event_type'], project_id: pid, actor: r['actor_id'], ip_address: r['ip_address'], metadata: r['metadata'] });
      if (rows.length) cursor['audit'] = rows[rows.length - 1]!['ts'];
    }
    if (sources.includes('auth')) {
      const rows = await sql`
        SELECT "timestamp"::text AS ts, event_type, user_id, ip_address, metadata FROM auth.auth_audit_log
        WHERE project_id = ${pid} AND "timestamp" > ${since('auth')}::timestamptz AND "timestamp" < NOW() - ${sql.unsafe(LAG)}
        ORDER BY "timestamp" LIMIT ${BATCH}`;
      for (const r of rows) {
        const ev = String(r['event_type']);
        events.push({ timestamp: new Date(r['ts']).toISOString(), source: 'auth', event: ev,
          level: /fail|locked|denied|banned/.test(ev) ? 'warn' : 'info', message: ev, project_id: pid,
          actor: r['user_id'], ip_address: r['ip_address'], metadata: r['metadata'] });
      }
      if (rows.length) cursor['auth'] = rows[rows.length - 1]!['ts'];
    }
    if (sources.includes('functions')) {
      const rows = await sql`
        SELECT l.created_at::text AS ts, f.slug, l.status, l.status_code, l.duration_ms, l.error, left(l.logs, 4000) AS logs
        FROM control_plane.function_logs l JOIN control_plane.functions f ON f.id = l.function_id
        WHERE l.project_id = ${pid} AND l.created_at > ${since('functions')}::timestamptz AND l.created_at < NOW() - ${sql.unsafe(LAG)}
        ORDER BY l.created_at LIMIT ${BATCH}`;
      for (const r of rows) events.push({ timestamp: new Date(r['ts']).toISOString(), source: 'functions', event: `${r['slug']} ${r['status']}`,
        level: r['status'] === 'success' ? 'info' : 'error', message: `${r['slug']} ${r['status']} ${r['status_code'] ?? ''} ${r['duration_ms']}ms`.replace(/\s+/g, ' '),
        project_id: pid, metadata: { function: r['slug'], status_code: r['status_code'], duration_ms: r['duration_ms'], error: r['error'], logs: r['logs'] } });
      if (rows.length) cursor['functions'] = rows[rows.length - 1]!['ts'];
    }
    if (sources.includes('platform') && lokiUrl) {
      // Loki cursor: nanosecond timestamp of the last line forwarded
      const startNs = cursor['platform'] ? BigInt(cursor['platform']) + 1n : BigInt(Date.now() - 60_000) * 1_000_000n;
      const endNs = BigInt(Date.now() - 2000) * 1_000_000n;
      if (endNs > startNs) {
        const q = `{service=~"${PLATFORM_SERVICES}"} |= "${pid}"`;
        const url = `${lokiUrl}/loki/api/v1/query_range?direction=forward&limit=${BATCH}&start=${startNs}&end=${endNs}&query=${encodeURIComponent(q)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`Loki responded ${r.status}`);
        const lines: [bigint, string, string][] = [];
        for (const s of ((await r.json()) as any)?.data?.result ?? []) {
          for (const [ts, line] of s.values ?? []) lines.push([BigInt(ts), String(line), String(s.stream?.service ?? 'platform')]);
        }
        lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [ts, line, service] of lines.slice(0, BATCH)) {
          let parsed: any = null;
          try { parsed = JSON.parse(line); } catch { /* plain text */ }
          events.push({ timestamp: new Date(Number(ts / 1_000_000n)).toISOString(), source: 'platform', event: service,
            level: pinoLevel(parsed?.level), message: parsed?.msg ?? line.slice(0, 4000), project_id: pid, metadata: parsed ?? { line: line.slice(0, 4000) } });
        }
        // nothing new: move the cursor to the end of the window so it does not fall behind
        cursor['platform'] = String(lines.length ? lines[Math.min(lines.length, BATCH) - 1]![0] : endNs);
      }
    }
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { events, cursor };
  }

  async function processDrain(d: Record<string, any>) {
    try {
      const { events, cursor } = await collect(d);
      if (events.length) {
        const secret = (await vault.reveal(d['project_id'], 'log_drain', d['id']))['secret'] ?? null;
        for (let i = 0; i < events.length; i += BATCH) {
          await sendToDrain({ id: d['id'], project_id: d['project_id'], kind: d['kind'], url: d['url'], config: d['config'] ?? {} },
            events.slice(i, i + BATCH), secret, assertPublicUrl);
        }
        await sql`UPDATE control_plane.log_drains SET cursor = ${sql.json(cursor)}, last_delivered_at = NOW(), last_error = NULL,
                  consecutive_failures = 0 WHERE id = ${d['id']}`;
      } else if (JSON.stringify(cursor) !== JSON.stringify(d['cursor'] ?? {})) {
        await sql`UPDATE control_plane.log_drains SET cursor = ${sql.json(cursor)} WHERE id = ${d['id']}`;
      }
    } catch (err) {
      const n = Number(d['consecutive_failures'] ?? 0) + 1;
      const wait = Math.min(2 ** Math.min(n, 12) * 5, 3600);
      await sql`UPDATE control_plane.log_drains SET consecutive_failures = ${n}, last_error = ${(err as Error).message.slice(0, 500)},
                next_attempt_at = NOW() + make_interval(secs => ${wait}), enabled = ${n < MAX_FAILURES} WHERE id = ${d['id']}`;
      // no project id in this log line: drains read the logs that mention a project
      logger.warn({ drain: d['id'], failures: n, err: (err as Error).message }, 'Log drain delivery failed');
    }
  }

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const drains = await sql`
        SELECT id, project_id, name, kind, url, config, sources, enabled, cursor, consecutive_failures FROM control_plane.log_drains
        WHERE enabled AND next_attempt_at <= NOW() ORDER BY next_attempt_at LIMIT 100`;
      for (const d of drains) await processDrain(d);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Log drain tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  return () => clearInterval(timer);
}
