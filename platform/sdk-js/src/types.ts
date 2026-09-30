export interface OdbError {
  message: string;
  status: number;
  code?: string;
  details?: unknown;
  hint?: string | null;
}

export interface OdbResponse<T> {
  data: T | null;
  error: OdbError | null;
  status: number;
  count?: number | null;
  /** Content-Range response header (row counts) */
  range?: string | null;
}

export type Fetch = typeof fetch;

export interface ClientContext {
  urls: { rest: string; auth: string; storage: string; functions: string; realtime: string };
  apiKey: string;
  fetch: Fetch;
  /** Authorization header value: the user's access token, else the API key. */
  bearer(): Promise<string>;
  headers?: Record<string, string>;
}

export async function toError(res: Response): Promise<OdbError> {
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return {
    status: res.status,
    message: body?.message ?? body?.error_description
      ?? (Array.isArray(body?.errors) ? body.errors.map((e: any) => e?.message).join('; ') : undefined)   // GraphQL
      ?? body?.error ?? res.statusText ?? `HTTP ${res.status}`,
    code: body?.code, details: body?.details, hint: body?.hint,
  };
}

export async function request<T>(ctx: ClientContext, url: string, init: RequestInit & { json?: unknown } = {}): Promise<OdbResponse<T>> {
  const headers = new Headers({ apikey: ctx.apiKey, ...(ctx.headers ?? {}) });
  headers.set('authorization', `Bearer ${await ctx.bearer()}`);
  new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  let body = init.body;
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json); }
  try {
    const res = await ctx.fetch(url, { ...init, headers, body });
    const range = res.headers.get('content-range');
    if (!res.ok) return { data: null, error: await toError(res), status: res.status, range };
    const text = res.status === 204 ? '' : await res.text();
    let data: any = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { data, error: null, status: res.status, range };
  } catch (err) {
    return { data: null, error: { status: 0, message: (err as Error).message }, status: 0 };
  }
}
