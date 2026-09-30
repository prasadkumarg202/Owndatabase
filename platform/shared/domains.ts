/**
 * Custom domains (CANONICAL COPY: platform/shared/domains.ts).
 *
 * A verified custom domain (control_plane.custom_domains) serves one project
 * with Supabase-style paths that leave out the project id:
 *
 *   https://api.example.com/rest/v1/orders        →  /v1/<projectId>/orders           (api-service)
 *   https://api.example.com/auth/v1/token          →  /v1/<projectId>/token            (auth-service)
 *   https://api.example.com/storage/v1/object/…    →  /v1/<projectId>/object/…         (storage-api)
 *   https://api.example.com/functions/v1/hello     →  /functions/v1/<projectId>/hello  (api-service)
 *   https://api.example.com/graphql/v1             →  /graphql/v1/<projectId>          (api-service)
 *   wss://api.example.com/realtime                 →  /realtime?project_id=<projectId> (realtime)
 *
 * Paths that already carry a project id are left alone (API keys still decide
 * access). Fastify's rewriteUrl is synchronous, so hostnames are kept in memory:
 * loaded at start, every minute, and on NOTIFY-style `odb:domains-changed`.
 */
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import type { IncomingMessage } from 'node:http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DomainMap {
  private hosts = new Map<string, string>();

  constructor(private db: postgres.Sql<any>, subscriber?: Redis) {
    void this.load();
    setInterval(() => void this.load(), 60_000).unref();
    if (subscriber) {
      void subscriber.subscribe('odb:domains-changed').catch(() => {});
      subscriber.on('message', (channel: string) => { if (channel === 'odb:domains-changed') void this.load(); });
    }
  }

  async load() {
    try {
      const rows = await this.db`SELECT hostname, project_id FROM control_plane.custom_domains WHERE status = 'verified'`;
      this.hosts = new Map(rows.map((r) => [String(r['hostname']).toLowerCase(), String(r['project_id'])]));
    } catch { /* table not there yet (migration 017) or DB down: keep the last map */ }
  }

  projectFor(host: string | undefined): string | null {
    if (!host) return null;
    return this.hosts.get(host.split(':')[0]!.toLowerCase()) ?? null;
  }

  /** For Fastify's rewriteUrl option. */
  rewrite = (req: IncomingMessage): string => {
    const url = req.url ?? '/';
    const pid = this.projectFor(String(req.headers['x-forwarded-host'] ?? req.headers.host ?? ''));
    if (!pid) return url;
    for (const prefix of ['/functions/v1/', '/graphql/v1/', '/v1/']) {
      if (url.startsWith(prefix)) {
        const next = url.slice(prefix.length).split(/[/?#]/)[0] ?? '';
        return UUID.test(next) ? url : `${prefix}${pid}/${url.slice(prefix.length)}`.replace(/\/$/, '');
      }
    }
    if (url === '/realtime' || url.startsWith('/realtime?') || url.startsWith('/realtime/')) {
      if (/[?&]project_id=/.test(url)) return url;
      return url + (url.includes('?') ? '&' : '?') + `project_id=${pid}`;
    }
    return url;
  };
}
