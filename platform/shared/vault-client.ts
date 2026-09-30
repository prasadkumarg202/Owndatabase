/**
 * Client for the control API's secrets vault (docs/vault.md). Services hold no encryption key:
 * they ask POST /api/internal/vault/reveal with their own token (VAULT_TOKEN) for the kinds of
 * secret their policy allows. Answers are cached briefly and dropped when the project changes.
 */
const TTL_MS = 60_000;

export class VaultClient {
  private cache = new Map<string, { value: Promise<Record<string, string>>; exp: number }>();

  constructor(private url = process.env['VAULT_URL'] ?? 'http://control-api:3000', private token = process.env['VAULT_TOKEN'] ?? '') {}

  get configured() { return !!this.token; }

  async reveal(projectId: string, kind: string, id?: string): Promise<Record<string, string>> {
    const key = `${projectId}:${kind}:${id ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = this.fetch(projectId, kind, id);
    this.cache.set(key, { value, exp: Date.now() + TTL_MS });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  invalidate(projectId?: string) {
    if (!projectId) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.startsWith(`${projectId}:`)) this.cache.delete(k);
  }

  private async fetch(projectId: string, kind: string, id?: string): Promise<Record<string, string>> {
    if (!this.token) throw new Error('VAULT_TOKEN is not set');
    const r = await fetch(`${this.url.replace(/\/$/, '')}/api/internal/vault/reveal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, kind, ...(id ? { id } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await r.json().catch(() => ({}))) as { secrets?: Record<string, string>; message?: string };
    if (!r.ok || !body.secrets) throw new Error(`vault: ${r.status} ${body.message ?? ''}`.trim());
    return body.secrets;
  }
}
