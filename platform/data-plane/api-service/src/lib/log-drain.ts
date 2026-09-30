/**
 * Sends a batch of log events to a log drain (docs/log-drains.md). Shared by the queue worker, which
 * forwards logs, and the control API, which sends test events.
 *
 *   webhook   POST <url> { drain_id, project_id, events: [...] }, signed like database webhooks:
 *             x-odb-timestamp + x-odb-signature: sha256=HMAC(secret, "<timestamp>.<body>")
 *   datadog   POST https://http-intake.logs.<site>/api/v2/logs   (DD-API-KEY: <secret>)
 *   logtail   POST https://in.logs.betterstack.com                  (Authorization: Bearer <secret>)
 */
import { createHmac } from 'node:crypto';

export interface DrainEvent {
  timestamp: string; source: string; event: string; level: string; message: string;
  project_id: string; actor?: string | null; ip_address?: string | null; metadata?: unknown;
}
export interface DrainTarget { id: string; project_id: string; kind: string; url: string | null; config: Record<string, any> }

export const DRAIN_SOURCES = ['audit', 'auth', 'functions', 'platform'] as const;

/** The URL a drain posts to. */
export function drainUrl(d: DrainTarget): string {
  if (d.url) return d.url;
  if (d.kind === 'datadog') return `https://http-intake.logs.${d.config?.['site'] || 'datadoghq.com'}/api/v2/logs`;
  if (d.kind === 'logtail') return 'https://in.logs.betterstack.com';
  throw new Error('A webhook drain needs a URL');
}

export async function sendToDrain(d: DrainTarget, events: DrainEvent[], secret: string | null, assertPublicUrl: (url: string) => Promise<void>) {
  const url = drainUrl(d);
  await assertPublicUrl(url);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'OwnDatabase-LogDrain/1.0' };
  let body: string;
  if (d.kind === 'datadog') {
    if (!secret) throw new Error('The Datadog drain has no API key');
    headers['DD-API-KEY'] = secret;
    body = JSON.stringify(events.map((e) => ({
      ddsource: 'owndatabase', service: `owndatabase-${e.source}`, hostname: 'owndatabase',
      ddtags: `project_id:${e.project_id},source:${e.source}`, status: e.level, message: e.message, date: e.timestamp,
      event: e.event, actor: e.actor ?? undefined, ip_address: e.ip_address ?? undefined, metadata: e.metadata,
    })));
  } else if (d.kind === 'logtail') {
    if (!secret) throw new Error('The Better Stack drain has no source token');
    headers['authorization'] = `Bearer ${secret}`;
    body = JSON.stringify(events.map((e) => ({ dt: e.timestamp, level: e.level, message: e.message, source: e.source, event: e.event,
      project_id: e.project_id, actor: e.actor ?? undefined, ip_address: e.ip_address ?? undefined, metadata: e.metadata })));
  } else {
    body = JSON.stringify({ drain_id: d.id, project_id: d.project_id, events });
    if (secret) {
      const ts = Math.floor(Date.now() / 1000);
      headers['x-odb-timestamp'] = String(ts);
      headers['x-odb-signature'] = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    }
  }
  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (res.status < 200 || res.status >= 300) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${new URL(url).host} responded ${res.status}${text ? `: ${text}` : ''}`);
  }
}
