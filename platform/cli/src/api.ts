/** HTTP client for the OwnDatabase platform (control API, storage, functions). */
import { loadConfig, saveConfig } from './config.js';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

function base(kind: 'api' | 'storage' | 'functions' | 'rest'): string {
  const cfg = loadConfig();
  const root = (process.env['ODB_URL'] ?? cfg.url).replace(/\/$/, '');
  const override = { api: process.env['ODB_API_URL'], storage: process.env['ODB_STORAGE_URL'], functions: process.env['ODB_FUNCTIONS_URL'], rest: process.env['ODB_REST_URL'] }[kind];
  if (override) return override.replace(/\/$/, '');
  return kind === 'api' ? root : `${root}/${kind}`;
}

async function refresh(): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.refresh_token) return false;
  const res = await fetch(`${base('api')}/api/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: cfg.refresh_token }),
  });
  if (!res.ok) return false;
  const body = await res.json() as any;
  saveConfig({ ...cfg, access_token: body.access_token, refresh_token: body.refresh_token });
  return true;
}

export async function request<T = any>(kind: 'api' | 'storage' | 'functions' | 'rest', path: string, init: RequestInit & { json?: unknown; raw?: boolean } = {}, retried = false): Promise<T> {
  const cfg = loadConfig();
  const token = process.env['ODB_TOKEN'] ?? cfg.access_token;
  const headers = new Headers(init.headers);
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json); }
  const res = await fetch(`${base(kind)}${path}`, { ...init, headers, body });
  if (res.status === 401 && !retried && !process.env['ODB_TOKEN'] && (await refresh())) {
    return request(kind, path, init, true);
  }
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, parsed?.message ?? parsed?.error ?? `HTTP ${res.status}`, parsed);
  return (init.raw ? text : parsed) as T;
}

export const api = <T = any>(path: string, init: Parameters<typeof request>[2] = {}) => request<T>('api', path, init);
