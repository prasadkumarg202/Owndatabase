/**
 * HTTP client for the OwnDatabase control API.
 *
 * Env:
 *   OWNDATABASE_URL        platform URL (default http://localhost) — control API at /api
 *   OWNDATABASE_API_URL    override the control API base (e.g. http://localhost:3000)
 *   OWNDATABASE_STORAGE_URL override the storage API base (default <url>/storage)
 *   OWNDATABASE_TOKEN      a platform access token, or
 *   OWNDATABASE_EMAIL + OWNDATABASE_PASSWORD  to sign in automatically (tokens refresh on expiry)
 */
const ROOT = (process.env['OWNDATABASE_URL'] ?? 'http://localhost').replace(/\/$/, '');
const API = (process.env['OWNDATABASE_API_URL'] ?? ROOT).replace(/\/$/, '');
const STORAGE = (process.env['OWNDATABASE_STORAGE_URL'] ?? `${ROOT}/storage`).replace(/\/$/, '');

let token = process.env['OWNDATABASE_TOKEN'] ?? '';
let refreshToken = '';

async function login(): Promise<void> {
  const email = process.env['OWNDATABASE_EMAIL'];
  const password = process.env['OWNDATABASE_PASSWORD'];
  if (!email || !password) throw new Error('Set OWNDATABASE_TOKEN, or OWNDATABASE_EMAIL and OWNDATABASE_PASSWORD');
  const res = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await res.json() as any;
  if (!res.ok) throw new Error(`Login failed: ${body.message ?? res.status}`);
  token = body.access_token; refreshToken = body.refresh_token;
}

async function refresh(): Promise<boolean> {
  if (refreshToken) {
    const res = await fetch(`${API}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) });
    if (res.ok) { const b = await res.json() as any; token = b.access_token; refreshToken = b.refresh_token; return true; }
  }
  if (process.env['OWNDATABASE_EMAIL']) { await login(); return true; }
  return false;
}

async function call(base: string, endpoint: string, init: RequestInit = {}, retried = false): Promise<any> {
  if (!token) await login();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${base}${endpoint}`, { ...init, headers });
  if (res.status === 401 && !retried && (await refresh())) return call(base, endpoint, init, true);
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* text */ }
  if (!res.ok) throw new Error(`${res.status}: ${body?.message ?? body?.error ?? text}`.slice(0, 2000));
  return body;
}

export const apiClient = (endpoint: string, init: RequestInit = {}) => call(API, endpoint, init);
export const storageClient = (endpoint: string, init: RequestInit = {}) => call(STORAGE, endpoint, init);
