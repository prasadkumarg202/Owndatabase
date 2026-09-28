/**
 * Browser API client.
 *
 * All calls go to same-origin paths (/api, /storage, /rest, /functions) which
 * Caddy (production) or next.config.mjs rewrites (development) route to the
 * right service. Tokens live in localStorage; a 401 triggers one refresh
 * attempt, then a redirect to /login.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); }
}

const isBrowser = typeof window !== 'undefined';

export const tokens = {
  get access() { return isBrowser ? localStorage.getItem('access_token') : null; },
  get refresh() { return isBrowser ? localStorage.getItem('refresh_token') : null; },
  set(access: string, refresh?: string) {
    localStorage.setItem('access_token', access);
    if (refresh) localStorage.setItem('refresh_token', refresh);
  },
  clear() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  },
};

export function currentUser(): { id: string; email: string } | null {
  const t = tokens.access;
  if (!t) return null;
  try {
    const p = JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return { id: p.sub, email: p.email };
  } catch { return null; }
}

let refreshing: Promise<boolean> | null = null;
async function refreshTokens(): Promise<boolean> {
  const rt = tokens.refresh;
  if (!rt) return false;
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }),
  }).then(async (r) => {
    if (!r.ok) return false;
    const b = await r.json();
    tokens.set(b.access_token, b.refresh_token);
    return true;
  }).catch(() => false).finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  return refreshing;
}

export async function request<T = any>(url: string, init: RequestInit & { json?: unknown; rawResponse?: boolean } = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  const t = tokens.access;
  if (t && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${t}`);
  let body = init.body;
  if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
  const res = await fetch(url, { ...init, headers, body });
  if (res.status === 401 && !retried && !url.startsWith('/api/auth/login')) {
    if (await refreshTokens()) return request(url, init, true);
    if (isBrowser && !location.pathname.startsWith('/login')) {
      tokens.clear();
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
  }
  if (init.rawResponse) return res as unknown as T;
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* text body */ }
  if (!res.ok) throw new ApiError(res.status, data?.message || data?.error || `Request failed (${res.status})`, data);
  return data as T;
}

function withPrefix(prefix: string, endpoint: string) {
  if (/^https?:\/\//.test(endpoint)) return endpoint;
  const e = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return e.startsWith(prefix + '/') ? e : `${prefix}${e}`;
}

function client(prefix: string) {
  return {
    get: <T = any>(e: string) => request<T>(withPrefix(prefix, e)),
    post: <T = any>(e: string, json?: unknown) => request<T>(withPrefix(prefix, e), { method: 'POST', json }),
    put: <T = any>(e: string, json?: unknown) => request<T>(withPrefix(prefix, e), { method: 'PUT', json }),
    patch: <T = any>(e: string, json?: unknown) => request<T>(withPrefix(prefix, e), { method: 'PATCH', json }),
    delete: <T = any>(e: string, json?: unknown) => request<T>(withPrefix(prefix, e), { method: 'DELETE', ...(json !== undefined ? { json } : {}) }),
    upload: <T = any>(e: string, file: File, upsert = false) => {
      const fd = new FormData();
      fd.append('file', file);
      return request<T>(withPrefix(prefix, e), { method: 'POST', body: fd, headers: upsert ? { 'x-upsert': 'true' } : {} });
    },
  };
}

/** Control plane API (/api/...) */
export const api = client('/api');
/** Storage API (/storage/v1/...) — accepts the dashboard token for project members */
export const storage = client('/storage');

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function formatDate(d: string | Date | null | undefined, withTime = true): string {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString(undefined, withTime
    ? { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: '2-digit' });
}

export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
