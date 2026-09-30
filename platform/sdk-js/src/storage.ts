/** Storage: buckets and files. */
import { request, type ClientContext, type OdbResponse } from './types.js';

type Body = Blob | ArrayBuffer | ArrayBufferView | string;

const clean = (p: string) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

export class BucketApi {
  constructor(private ctx: ClientContext, private bucket: string) {}

  private url(kind: string, path = '') { return `${this.ctx.urls.storage}/object/${kind ? `${kind}/` : ''}${encodeURIComponent(this.bucket)}${path ? `/${clean(path)}` : ''}`; }

  upload(path: string, body: Body, opts: { upsert?: boolean; contentType?: string; cacheControl?: string } = {}): Promise<OdbResponse<{ Key: string; public_url: string | null }>> {
    const headers: Record<string, string> = { 'content-type': opts.contentType ?? (typeof Blob !== 'undefined' && body instanceof Blob && body.type ? body.type : 'application/octet-stream') };
    if (opts.upsert) headers['x-upsert'] = 'true';
    if (opts.cacheControl) headers['cache-control'] = opts.cacheControl;
    return request(this.ctx, this.url('', path), { method: 'POST', headers, body: body as BodyInit });
  }

  update(path: string, body: Body, opts: { contentType?: string } = {}) {
    return this.upload(path, body, { ...opts, upsert: true });
  }

  /** Downloads a file (with the user's / key's access). */
  async download(path: string): Promise<OdbResponse<Blob>> {
    const headers = new Headers({ apikey: this.ctx.apiKey, authorization: `Bearer ${await this.ctx.bearer()}` });
    try {
      const res = await this.ctx.fetch(this.url('', path), { headers });
      if (!res.ok) return { data: null, status: res.status, error: { status: res.status, message: (await res.json().catch(() => ({})))?.message ?? res.statusText } };
      return { data: await res.blob(), error: null, status: res.status };
    } catch (err) {
      return { data: null, error: { status: 0, message: (err as Error).message }, status: 0 };
    }
  }

  remove(paths: string[]) {
    return request<{ deleted: number }>(this.ctx, `${this.ctx.urls.storage}/object/${encodeURIComponent(this.bucket)}`, { method: 'DELETE', json: { prefixes: paths } });
  }

  list(prefix = '', opts: { limit?: number; offset?: number; search?: string; sortBy?: { column: 'name' | 'created_at' | 'updated_at' | 'size_bytes'; order: 'asc' | 'desc' } } = {}) {
    return request<any[]>(this.ctx, `${this.ctx.urls.storage}/object/list/${encodeURIComponent(this.bucket)}`, { method: 'POST', json: { prefix, ...opts } });
  }

  move(from: string, to: string) {
    return request(this.ctx, `${this.ctx.urls.storage}/object/move`, { method: 'POST', json: { bucketId: this.bucket, sourceKey: from, destinationKey: to } });
  }

  copy(from: string, to: string) {
    return request(this.ctx, `${this.ctx.urls.storage}/object/copy`, { method: 'POST', json: { bucketId: this.bucket, sourceKey: from, destinationKey: to } });
  }

  async createSignedUrl(path: string, expiresIn: number): Promise<OdbResponse<{ signedUrl: string }>> {
    const r = await request<any>(this.ctx, this.url('sign', path), { method: 'POST', json: { expiresIn } });
    return r.error ? { ...r, data: null } : { ...r, data: { signedUrl: r.data.signedUrl } };
  }

  /** URL of a file in a public bucket (no request is made). */
  getPublicUrl(path: string, opts: { transform?: { width?: number; height?: number; resize?: 'cover' | 'contain' | 'fill'; format?: 'webp' | 'png' | 'jpeg' | 'avif'; quality?: number } } = {}) {
    if (opts.transform) {
      const q = new URLSearchParams(Object.entries(opts.transform).map(([k, v]) => [k, String(v)]));
      return { data: { publicUrl: `${this.ctx.urls.storage}/render/image/public/${encodeURIComponent(this.bucket)}/${clean(path)}?${q}` } };
    }
    return { data: { publicUrl: this.url('public', path) } };
  }
}

export class StorageClient {
  constructor(private ctx: ClientContext) {}
  from(bucket: string) { return new BucketApi(this.ctx, bucket); }
  listBuckets() { return request<any[]>(this.ctx, `${this.ctx.urls.storage}/bucket`); }
  getBucket(name: string) { return request<any>(this.ctx, `${this.ctx.urls.storage}/bucket/${encodeURIComponent(name)}`); }
  createBucket(name: string, opts: { public?: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] } = {}) {
    return request<any>(this.ctx, `${this.ctx.urls.storage}/bucket`, { method: 'POST', json: { name, public: !!opts.public, file_size_limit: opts.fileSizeLimit, allowed_mime_types: opts.allowedMimeTypes } });
  }
  emptyBucket(name: string) { return request(this.ctx, `${this.ctx.urls.storage}/bucket/${encodeURIComponent(name)}/empty`, { method: 'POST' }); }
  deleteBucket(name: string) { return request(this.ctx, `${this.ctx.urls.storage}/bucket/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
}
