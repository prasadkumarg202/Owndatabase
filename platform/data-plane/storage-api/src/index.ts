/**
 * OwnDatabase Storage API (Phase 4)
 *
 * Buckets
 *   GET    /v1/:projectId/bucket                     list
 *   POST   /v1/:projectId/bucket                     create { name, public, file_size_limit, allowed_mime_types, read_access, write_access }
 *   GET    /v1/:projectId/bucket/:name
 *   PUT    /v1/:projectId/bucket/:name               update settings
 *   POST   /v1/:projectId/bucket/:name/empty
 *   DELETE /v1/:projectId/bucket/:name               (must be empty)
 *
 * Objects
 *   POST   /v1/:projectId/object/:bucket/*           upload (multipart field "file" or raw body; x-upsert: true to overwrite)
 *   PUT    /v1/:projectId/object/:bucket/*           overwrite
 *   GET    /v1/:projectId/object/:bucket/*           download (authenticated)
 *   GET    /v1/:projectId/object/public/:bucket/*    download from a public bucket (no key needed)
 *   GET    /v1/:projectId/object/info/:bucket/*      metadata
 *   DELETE /v1/:projectId/object/:bucket/*
 *   DELETE /v1/:projectId/object/:bucket            bulk delete { prefixes: [...] }
 *   POST   /v1/:projectId/object/list/:bucket        { prefix, limit, offset, search, sortBy }
 *   POST   /v1/:projectId/object/move | copy         { bucketId, sourceKey, destinationKey }
 *   POST   /v1/:projectId/object/sign/:bucket/*      { expiresIn } → signed URL
 *   GET    /v1/:projectId/object/sign/:bucket/*?token=
 *   GET    /v1/:projectId/render/image/{public|authenticated|sign}/:bucket/*?width&height&resize&format&quality
 *
 * Access model (per bucket, stored in storage.buckets.metadata):
 *   read_access  = public | authenticated | owner   (default: public for public buckets, owner otherwise)
 *   write_access = authenticated | owner | service  (default: owner)
 * service_role keys and dashboard users bypass these rules.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { collectDefaultMetrics, register, Counter } from 'prom-client';
import postgres from 'postgres';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { AuthError, PlatformAuth, type RequestAuth } from './lib/platform-auth.js';
import { createBackend } from './lib/backend.js';
import { limitOf, QUOTA_ERROR } from './lib/limits.js';
import { initTracing, shutdownTracing, tracingPlugin } from './lib/tracing.js';
import { DomainMap } from './lib/domains.js';

const PORT = Number(process.env['PORT'] ?? 3005);
const DATABASE_URL = process.env['DATABASE_URL']!;
const REDIS_URL = process.env['REDIS_URL']!;
const JWT_SECRET = process.env['JWT_SECRET']!;
const PUBLIC_URL = (process.env['PUBLIC_URL'] ?? 'http://localhost').replace(/\/$/, '');
const STORAGE_PUBLIC_PATH = process.env['STORAGE_PUBLIC_PATH'] ?? '/storage';
const MAX_UPLOAD_SIZE = Number(process.env['MAX_UPLOAD_SIZE'] ?? 100 * 1024 * 1024);
for (const [k, v] of Object.entries({ DATABASE_URL, REDIS_URL, JWT_SECRET })) {
  if (!v) { console.error(`${k} is required`); process.exit(1); }
}

const db = postgres(DATABASE_URL, { max: 10, idle_timeout: 30, onnotice: () => {} });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', () => {}); redisSub.on('error', () => {});
const platform = new PlatformAuth(db, JWT_SECRET, redisSub);
const backend = createBackend();
const signSecret = new TextEncoder().encode(JWT_SECRET);

collectDefaultMetrics({ prefix: 'owndatabase_storage_' });
const uploadBytes = new Counter({ name: 'owndatabase_storage_upload_bytes_total', help: 'Bytes uploaded', labelNames: ['project_id'] });
const downloadBytes = new Counter({ name: 'owndatabase_storage_download_bytes_total', help: 'Bytes downloaded', labelNames: ['project_id'] });

let sharp: any = null;
try { sharp = (await import('sharp')).default; } catch { /* image transforms disabled */ }

// ── Helpers ──────────────────────────────────────────────────────────────────

interface Bucket {
  id: string; project_id: string; name: string; is_public: boolean; file_size_limit: number | null;
  allowed_mime_types: string[] | null; metadata: Record<string, any>; created_at: Date; updated_at: Date;
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const BUCKET_NAME = /^(?!(public|sign|info|list|move|copy|authenticated)$)[a-z0-9][a-z0-9._-]{0,62}$/;

function validPath(p: string | undefined): string {
  if (!p) throw new HttpError(400, 'Object path is required');
  const path = decodeURIComponent(p).replace(/^\/+/, '');
  if (path.length > 1000 || /[\x00-\x1f\\]/.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new HttpError(400, 'Invalid object path');
  }
  return path;
}

const storageKey = (b: Bucket, path: string) => `${b.project_id}/${b.id}/${path}`;

function bucketView(b: Bucket) {
  return {
    id: b.id, name: b.name, public: b.is_public, file_size_limit: b.file_size_limit === null ? null : Number(b.file_size_limit),
    allowed_mime_types: b.allowed_mime_types ?? [],
    read_access: b.metadata?.['read_access'] ?? (b.is_public ? 'public' : 'owner'),
    write_access: b.metadata?.['write_access'] ?? 'owner',
    created_at: b.created_at, updated_at: b.updated_at,
  };
}

async function getBucket(projectId: string, name: string): Promise<Bucket> {
  const [b] = await db<Bucket[]>`SELECT * FROM storage.buckets WHERE project_id = ${projectId} AND name = ${name}`;
  if (!b) throw new HttpError(404, `Bucket '${name}' not found`);
  return b;
}

// Requests per minute per API key + client (or per signed-in user), as in the REST API; fails open without Redis
const RATE_LIMITS = {
  anon: Number(process.env['STORAGE_RATE_LIMIT_ANON'] ?? 600),
  authenticated: Number(process.env['STORAGE_RATE_LIMIT_AUTHENTICATED'] ?? 1200),
  service_role: Number(process.env['STORAGE_RATE_LIMIT_SERVICE'] ?? 6000),
};

async function rateLimit(req: FastifyRequest, a: RequestAuth) {
  if (String(a.key.id).startsWith('platform:')) return;  // dashboard users
  const limit = RATE_LIMITS[a.role as keyof typeof RATE_LIMITS] ?? RATE_LIMITS.anon;
  const who = a.userId ? `u:${a.userId}` : `k:${a.key.id}:${req.ip}`;
  const key = `storage-rl:${a.project.id}:${who}:${Math.floor(Date.now() / 60000)}`;
  let n: number;
  try {
    n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 61);
  } catch { return; }
  if (n > limit) throw new HttpError(429, `Rate limit of ${limit} requests/minute exceeded`);
}

async function ctx(req: FastifyRequest): Promise<RequestAuth> {
  const { projectId } = req.params as { projectId: string };
  let a: RequestAuth;
  try {
    a = await platform.authenticate(projectId, req.headers as any, req.query as any, { allowPlatformUser: true, ip: req.ip });
  } catch (err) {
    if (err instanceof AuthError) throw new HttpError(err.statusCode, err.message);
    throw err;
  }
  await rateLimit(req, a);
  return a;
}

function requireService(a: RequestAuth) {
  if (a.role !== 'service_role') throw new HttpError(403, 'Bucket management requires a service_role key or dashboard access');
}

function canRead(a: RequestAuth, b: Bucket, owner: string | null): boolean {
  if (a.role === 'service_role' || b.is_public) return true;
  const mode = bucketView(b).read_access;
  if (mode === 'public') return true;
  if (mode === 'authenticated') return a.role === 'authenticated';
  return !!a.userId && a.userId === owner;
}

function canWrite(a: RequestAuth, b: Bucket, existingOwner: string | null | undefined): boolean {
  if (a.role === 'service_role') return true;
  const mode = bucketView(b).write_access;
  if (mode === 'service' || a.role !== 'authenticated') return false;
  if (mode === 'authenticated') return true;
  return existingOwner === undefined || existingOwner === null || existingOwner === a.userId;
}

async function usage(projectId: string, field: string, n = 1) {
  const day = new Date().toISOString().slice(0, 10);
  await redis.hincrby(`odb:usage:${projectId}:${day}`, field, n).catch(() => {});
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.status === 404 ? 'Not Found' : err.status === 403 ? 'Forbidden' : err.status === 402 ? QUOTA_ERROR : 'Error', statusCode: err.status, message: err.message });
  const e = err as any;
  if (e?.code === '23505') return reply.status(409).send({ error: 'Conflict', message: 'Already exists' });
  reply.log.error({ err }, 'Storage error');
  return reply.status(500).send({ error: 'Internal Server Error', message: 'Storage operation failed' });
}

async function signToken(projectId: string, bucket: string, path: string, expiresIn: number, transform?: Record<string, unknown>) {
  return new SignJWT({ p: projectId, b: bucket, k: path, ...(transform ? { t: transform } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('owndatabase-storage')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(signSecret);
}

async function verifySigned(token: string, projectId: string, bucket: string, path: string) {
  try {
    const { payload } = await jwtVerify(token, signSecret, { issuer: 'owndatabase-storage' });
    if (payload['p'] !== projectId || payload['b'] !== bucket || payload['k'] !== path) throw new Error('mismatch');
    return payload;
  } catch {
    throw new HttpError(400, 'Invalid or expired signed URL');
  }
}

async function sendObject(req: FastifyRequest, reply: FastifyReply, b: Bucket, obj: any, transform?: Record<string, any>) {
  const stored = await backend.get(storageKey(b, obj.name));
  if (!stored) throw new HttpError(404, 'Object data missing from storage backend');
  reply.header('Cache-Control', b.is_public ? 'public, max-age=3600' : 'private, max-age=0, no-store');
  reply.header('ETag', `"${obj.etag}"`);
  reply.header('Last-Modified', new Date(obj.updated_at).toUTCString());
  if (req.headers['if-none-match'] === `"${obj.etag}"` && !transform) return reply.status(304).send();

  const q = (req.query ?? {}) as Record<string, string>;
  const t = transform ?? (q['width'] || q['height'] || q['format'] || q['quality'] ? q : null);
  if (t && String(obj.mime_type).startsWith('image/')) {
    if (!sharp) throw new HttpError(501, 'Image transformation is not available on this server');
    const chunks: Buffer[] = [];
    for await (const c of stored.stream) chunks.push(c as Buffer);
    const width = t['width'] ? Math.min(Number(t['width']), 4000) : undefined;
    const height = t['height'] ? Math.min(Number(t['height']), 4000) : undefined;
    const fit = ({ cover: 'cover', contain: 'contain', fill: 'fill' } as Record<string, string>)[t['resize'] ?? 'cover'] ?? 'cover';
    const format = (['webp', 'avif', 'jpeg', 'png'].includes(t['format']) ? t['format'] : t['format'] === 'origin' ? null : 'webp') as string | null;
    const quality = Math.min(Math.max(Number(t['quality']) || 80, 20), 100);
    let img = sharp(Buffer.concat(chunks), { failOn: 'none' }).rotate();
    if (width || height) img = img.resize({ width, height, fit, withoutEnlargement: true });
    if (format) img = img.toFormat(format, { quality });
    const out: Buffer = await img.toBuffer();
    downloadBytes.inc({ project_id: b.project_id }, out.length);
    return reply.type(format ? `image/${format}` : obj.mime_type).header('Content-Length', out.length).send(out);
  }
  downloadBytes.inc({ project_id: b.project_id }, stored.size);
  await usage(b.project_id, 'storage_downloads');
  const q2 = req.query as Record<string, string> | undefined;
  if (q2?.['download'] !== undefined) {
    const filename = q2['download'] || obj.name.split('/').pop();
    reply.header('Content-Disposition', `attachment; filename="${String(filename).replace(/"/g, '')}"`);
  }
  return reply.type(obj.mime_type || 'application/octet-stream').header('Content-Length', stored.size).send(stored.stream);
}

/** Refuses a write that would take the project over its storage_bytes limit. */
async function assertStorageQuota(project: { id: string; settings?: Record<string, any> | null }, adding: number, replacing = 0) {
  const max = limitOf(project, 'storage_bytes');
  if (max === null) return;
  const [r] = await db`
    SELECT COALESCE(sum(o.size_bytes), 0)::bigint AS used FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id
    WHERE b.project_id = ${project.id} AND NOT o.is_deleted`;
  if (Number(r?.['used'] ?? 0) - replacing + adding > max) {
    throw new HttpError(402, `This upload would take the project over its storage limit of ${max} bytes`);
  }
}

async function findObject(b: Bucket, path: string) {
  const [o] = await db`SELECT * FROM storage.objects WHERE bucket_id = ${b.id} AND name = ${path} AND NOT is_deleted`;
  return o ?? null;
}

// ── Server ───────────────────────────────────────────────────────────────────

initTracing('storage-api');
// custom domains: api.example.com/… → the project's paths (see lib/domains.ts)
const domains = new DomainMap(db, redisSub);
const server = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info', base: { service: 'storage-api' } }, trustProxy: true, rewriteUrl: domains.rewrite, bodyLimit: MAX_UPLOAD_SIZE });
tracingPlugin(server);
// Supabase clients send "content-type: application/json" with no body (e.g. POST /logout)
server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (body === '' || body === undefined) return done(null, {});
  try { done(null, JSON.parse(body as string)); } catch (err) { (err as any).statusCode = 400; done(err as Error, undefined); }
});
await server.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
await server.register(cors, { origin: true, credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-api-key', 'x-upsert', 'cache-control', 'x-client-info'] });
await server.register(multipart, { limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 } });
server.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_SIZE }, (_req, body, done) => done(null, body));

server.get('/health', async () => ({ status: 'ok', service: 'storage-api', backend: backend.name, image_transforms: !!sharp, timestamp: new Date().toISOString() }));
server.get('/health/ready', async (_req, reply) => {
  const checks: Record<string, string> = {};
  try { await db`SELECT 1`; checks['postgresql'] = 'healthy'; } catch { checks['postgresql'] = 'unhealthy'; }
  try { await redis.ping(); checks['redis'] = 'healthy'; } catch { checks['redis'] = 'unhealthy'; }
  checks['backend'] = (await backend.health()) ? 'healthy' : 'unhealthy';
  const ok = Object.values(checks).every((v) => v === 'healthy');
  return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
});
server.get('/metrics', async (_req, reply) => reply.header('Content-Type', register.contentType).send(await register.metrics()));

// ── Buckets ──────────────────────────────────────────────────────────────────

const bucketSchema = z.object({
  name: z.string().regex(BUCKET_NAME, 'Bucket names: lowercase letters, digits, dot, dash, underscore (max 63); reserved: public, sign, info, list, move, copy, authenticated'),
  public: z.boolean().default(false),
  file_size_limit: z.number().int().positive().max(MAX_UPLOAD_SIZE).nullable().optional(),
  allowed_mime_types: z.array(z.string().regex(/^[\w.+-]+\/[\w.+*-]+$/)).nullable().optional(),
  read_access: z.enum(['public', 'authenticated', 'owner']).optional(),
  write_access: z.enum(['authenticated', 'owner', 'service']).optional(),
});

server.get('/v1/:projectId/bucket', async (req, reply) => {
  try {
    const a = await ctx(req);
    const rows = await db<(Bucket & { object_count: number; size_bytes: string })[]>`
      SELECT b.*, (SELECT count(*)::int FROM storage.objects o WHERE o.bucket_id = b.id AND NOT o.is_deleted) AS object_count,
             (SELECT COALESCE(sum(o.size_bytes),0)::bigint FROM storage.objects o WHERE o.bucket_id = b.id AND NOT o.is_deleted) AS size_bytes
      FROM storage.buckets b WHERE b.project_id = ${a.project.id} ORDER BY b.created_at`;
    const visible = a.role === 'service_role' ? rows : rows.filter((r) => r.is_public || bucketView(r).read_access !== 'owner' || a.role === 'authenticated');
    return reply.send(visible.map((r) => ({ ...bucketView(r), object_count: r.object_count, size_bytes: Number(r.size_bytes) })));
  } catch (err) { return fail(reply, err); }
});

server.post('/v1/:projectId/bucket', async (req, reply) => {
  try {
    const a = await ctx(req);
    requireService(a);
    const input = bucketSchema.safeParse(req.body);
    if (!input.success) throw new HttpError(400, input.error.errors[0]?.message ?? 'Invalid input');
    const b = input.data;
    const meta = { read_access: b.read_access ?? (b.public ? 'public' : 'owner'), write_access: b.write_access ?? 'owner' };
    const [row] = await db<Bucket[]>`
      INSERT INTO storage.buckets (project_id, name, is_public, file_size_limit, allowed_mime_types, metadata)
      VALUES (${a.project.id}, ${b.name}, ${b.public}, ${b.file_size_limit ?? null}, ${db.json((b.allowed_mime_types ?? []) as any)}, ${db.json(meta)})
      RETURNING *`;
    return reply.status(201).send(bucketView(row!));
  } catch (err) { return fail(reply, err); }
});

server.get('/v1/:projectId/bucket/:name', async (req, reply) => {
  try {
    const a = await ctx(req);
    const b = await getBucket(a.project.id, (req.params as any).name);
    if (!canRead(a, b, null) && a.role !== 'authenticated') throw new HttpError(404, 'Bucket not found');
    return reply.send(bucketView(b));
  } catch (err) { return fail(reply, err); }
});

server.put('/v1/:projectId/bucket/:name', async (req, reply) => {
  try {
    const a = await ctx(req);
    requireService(a);
    const b = await getBucket(a.project.id, (req.params as any).name);
    const input = bucketSchema.omit({ name: true }).partial().safeParse(req.body);
    if (!input.success) throw new HttpError(400, input.error.errors[0]?.message ?? 'Invalid input');
    const d = input.data;
    const meta = { ...b.metadata, ...(d.read_access ? { read_access: d.read_access } : {}), ...(d.write_access ? { write_access: d.write_access } : {}) };
    if (d.public !== undefined && !d.read_access) meta['read_access'] = d.public ? 'public' : (meta['read_access'] === 'public' ? 'owner' : meta['read_access']);
    const [row] = await db<Bucket[]>`
      UPDATE storage.buckets SET
        is_public = ${d.public ?? b.is_public},
        file_size_limit = ${d.file_size_limit === undefined ? b.file_size_limit : d.file_size_limit},
        allowed_mime_types = ${db.json((d.allowed_mime_types === undefined ? b.allowed_mime_types : d.allowed_mime_types ?? []) as any)},
        metadata = ${db.json(meta as any)}
      WHERE id = ${b.id} RETURNING *`;
    return reply.send(bucketView(row!));
  } catch (err) { return fail(reply, err); }
});

async function emptyBucket(b: Bucket) {
  const objs = await db`SELECT name FROM storage.objects WHERE bucket_id = ${b.id}`;
  for (const o of objs) await backend.delete(storageKey(b, o['name'] as string)).catch(() => {});
  await db`DELETE FROM storage.objects WHERE bucket_id = ${b.id}`;
  return objs.length;
}

server.post('/v1/:projectId/bucket/:name/empty', async (req, reply) => {
  try {
    const a = await ctx(req);
    requireService(a);
    const b = await getBucket(a.project.id, (req.params as any).name);
    return reply.send({ message: 'Emptied', deleted: await emptyBucket(b) });
  } catch (err) { return fail(reply, err); }
});

server.delete('/v1/:projectId/bucket/:name', async (req, reply) => {
  try {
    const a = await ctx(req);
    requireService(a);
    const b = await getBucket(a.project.id, (req.params as any).name);
    const force = (req.query as any)?.force === 'true';
    const [{ n }] = await db`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = ${b.id} AND NOT is_deleted` as any;
    if (n > 0 && !force) throw new HttpError(409, 'Bucket is not empty. Empty it first or pass ?force=true');
    if (n > 0) await emptyBucket(b);
    await db`DELETE FROM storage.buckets WHERE id = ${b.id}`;
    return reply.send({ message: 'Deleted' });
  } catch (err) { return fail(reply, err); }
});

// ── Objects ──────────────────────────────────────────────────────────────────

async function upload(req: FastifyRequest, reply: FastifyReply, forceUpsert: boolean) {
  try {
    const a = await ctx(req);
    const { bucket } = req.params as { bucket: string };
    const path = validPath((req.params as any)['*']);
    const b = await getBucket(a.project.id, bucket);

    let data: Buffer;
    let mime: string;
    let userMeta: Record<string, unknown> = {};
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, 'No file in multipart body (field name: file)');
      data = await file.toBuffer();
      mime = file.mimetype || 'application/octet-stream';
      const metaField = (file.fields as any)?.['metadata']?.value;
      if (metaField) { try { userMeta = JSON.parse(metaField); } catch { /* ignore */ } }
      if (file.file.truncated) throw new HttpError(413, `File exceeds the ${MAX_UPLOAD_SIZE} byte server limit`);
    } else {
      data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
      mime = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!;
    }
    if (!data.length) throw new HttpError(400, 'Empty file');
    if (b.file_size_limit && data.length > Number(b.file_size_limit)) {
      throw new HttpError(413, `File size ${data.length} exceeds the bucket limit of ${b.file_size_limit} bytes`);
    }
    const allowed = b.allowed_mime_types ?? [];
    if (allowed.length && !allowed.some((m) => m === mime || (m.endsWith('/*') && mime.startsWith(m.slice(0, -1))))) {
      throw new HttpError(415, `MIME type ${mime} is not allowed in this bucket (allowed: ${allowed.join(', ')})`);
    }

    const existing = await findObject(b, path);
    const upsert = forceUpsert || String(req.headers['x-upsert'] ?? '') === 'true';
    if (existing && !upsert) throw new HttpError(409, 'The object already exists. Send x-upsert: true to overwrite.');
    if (!canWrite(a, b, existing ? (existing['owner'] as string | null) : undefined)) throw new HttpError(403, 'Not allowed to write to this bucket');
    await assertStorageQuota(a.project, data.length, existing ? Number(existing['size_bytes']) : 0);

    const etag = createHash('md5').update(data).digest('hex');
    await backend.put(storageKey(b, path), data, mime);
    const [obj] = await db`
      INSERT INTO storage.objects (bucket_id, name, owner, size_bytes, mime_type, etag, storage_path, metadata)
      VALUES (${b.id}, ${path}, ${a.userId}, ${data.length}, ${mime}, ${etag}, ${storageKey(b, path)}, ${db.json(userMeta as any)})
      ON CONFLICT (bucket_id, name) DO UPDATE SET
        size_bytes = EXCLUDED.size_bytes, mime_type = EXCLUDED.mime_type, etag = EXCLUDED.etag,
        storage_path = EXCLUDED.storage_path, metadata = EXCLUDED.metadata, is_deleted = false,
        owner = COALESCE(storage.objects.owner, EXCLUDED.owner)
      RETURNING id, name, owner, size_bytes, mime_type, etag, created_at, updated_at`;
    uploadBytes.inc({ project_id: a.project.id }, data.length);
    await usage(a.project.id, 'storage_uploads');
    return reply.status(200).send({
      Key: `${bucket}/${path}`, Id: obj!['id'], ...obj, size_bytes: Number(obj!['size_bytes']),
      public_url: b.is_public ? `${PUBLIC_URL}${STORAGE_PUBLIC_PATH}/v1/${a.project.id}/object/public/${bucket}/${path}` : null,
    });
  } catch (err) { return fail(reply, err); }
}

server.post('/v1/:projectId/object/:bucket/*', (req, reply) => upload(req, reply, false));
server.put('/v1/:projectId/object/:bucket/*', (req, reply) => upload(req, reply, true));

server.get('/v1/:projectId/object/public/:bucket/*', async (req, reply) => {
  try {
    const { projectId, bucket } = req.params as { projectId: string; bucket: string };
    const project = await platform.getProject(projectId);
    if (!project || project.status !== 'active') throw new HttpError(404, 'Not found');
    const path = validPath((req.params as any)['*']);
    const b = await getBucket(projectId, bucket);
    if (!b.is_public) throw new HttpError(400, 'Bucket is not public');
    const obj = await findObject(b, path);
    if (!obj) throw new HttpError(404, 'Object not found');
    return sendObject(req, reply, b, obj);
  } catch (err) { return fail(reply, err); }
});

server.get('/v1/:projectId/object/sign/:bucket/*', async (req, reply) => {
  try {
    const { projectId, bucket } = req.params as { projectId: string; bucket: string };
    const path = validPath((req.params as any)['*']);
    const payload = await verifySigned(String((req.query as any)?.token ?? ''), projectId, bucket, path);
    const b = await getBucket(projectId, bucket);
    const obj = await findObject(b, path);
    if (!obj) throw new HttpError(404, 'Object not found');
    await db`UPDATE storage.signed_urls SET use_count = use_count + 1, used_at = NOW() WHERE token = ${createHash('sha256').update(String((req.query as any).token)).digest('hex')}`;
    return sendObject(req, reply, b, obj, (payload['t'] as Record<string, unknown> | undefined) ?? undefined);
  } catch (err) { return fail(reply, err); }
});

server.get('/v1/:projectId/object/info/:bucket/*', async (req, reply) => {
  try {
    const a = await ctx(req);
    const { bucket } = req.params as { bucket: string };
    const path = validPath((req.params as any)['*']);
    const b = await getBucket(a.project.id, bucket);
    const obj = await findObject(b, path);
    if (!obj || !canRead(a, b, obj['owner'] as string | null)) throw new HttpError(404, 'Object not found');
    return reply.send({ ...obj, size_bytes: Number(obj['size_bytes']) });
  } catch (err) { return fail(reply, err); }
});

server.get('/v1/:projectId/object/authenticated/:bucket/*', (req, reply) => download(req, reply));
server.get('/v1/:projectId/object/:bucket/*', (req, reply) => download(req, reply));
async function download(req: FastifyRequest, reply: FastifyReply) {
  try {
    const a = await ctx(req);
    const { bucket } = req.params as { bucket: string };
    const path = validPath((req.params as any)['*']);
    const b = await getBucket(a.project.id, bucket);
    const obj = await findObject(b, path);
    if (!obj || !canRead(a, b, obj['owner'] as string | null)) throw new HttpError(404, 'Object not found');
    return sendObject(req, reply, b, obj);
  } catch (err) { return fail(reply, err); }
}

async function deleteObjects(a: RequestAuth, b: Bucket, paths: string[]) {
  const deleted: string[] = [];
  for (const path of paths) {
    const obj = await findObject(b, path);
    if (!obj) continue;
    if (!canWrite(a, b, obj['owner'] as string | null)) throw new HttpError(403, `Not allowed to delete '${path}'`);
    await backend.delete(storageKey(b, path)).catch(() => {});
    await db`DELETE FROM storage.objects WHERE id = ${obj['id'] as string}`;
    deleted.push(path);
  }
  return deleted;
}

server.delete('/v1/:projectId/object/:bucket/*', async (req, reply) => {
  try {
    const a = await ctx(req);
    const { bucket } = req.params as { bucket: string };
    const path = validPath((req.params as any)['*']);
    const b = await getBucket(a.project.id, bucket);
    const deleted = await deleteObjects(a, b, [path]);
    if (!deleted.length) throw new HttpError(404, 'Object not found');
    return reply.send({ message: 'Deleted', deleted });
  } catch (err) { return fail(reply, err); }
});

server.delete('/v1/:projectId/object/:bucket', async (req, reply) => {
  try {
    const a = await ctx(req);
    const b = await getBucket(a.project.id, (req.params as any).bucket);
    const body = z.object({ prefixes: z.array(z.string()).min(1).max(1000) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Body must be { prefixes: [paths] }');
    const deleted = await deleteObjects(a, b, body.data.prefixes.map(validPath));
    return reply.send(deleted.map((name) => ({ name })));
  } catch (err) { return fail(reply, err); }
});

server.post('/v1/:projectId/object/list/:bucket', async (req, reply) => {
  try {
    const a = await ctx(req);
    const b = await getBucket(a.project.id, (req.params as any).bucket);
    const q = z.object({
      prefix: z.string().default(''), limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).default(0),
      search: z.string().optional(), sortBy: z.object({ column: z.enum(['name', 'created_at', 'updated_at', 'size_bytes']), order: z.enum(['asc', 'desc']) }).optional(),
    }).safeParse(req.body ?? {});
    if (!q.success) throw new HttpError(400, 'Invalid list options');
    const prefix = q.data.prefix.replace(/^\/+/, '');
    const pfx = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
    const search = q.data.search ? `%${q.data.search.replace(/[%_]/g, '\\$&')}%` : null;
    const ownerOnly = a.role !== 'service_role' && !b.is_public && bucketView(b).read_access === 'owner';
    if (a.role === 'anon' && !canRead(a, b, null)) throw new HttpError(403, 'Not allowed to list this bucket');
    const col = q.data.sortBy?.column ?? 'name';
    const dir = q.data.sortBy?.order === 'desc' ? db`DESC` : db`ASC`;

    // Direct children: files at this level + one entry per sub-"folder"
    const rows = await db`
      WITH scoped AS (
        SELECT o.*, substr(o.name, ${pfx.length + 1}) AS rest FROM storage.objects o
        WHERE o.bucket_id = ${b.id} AND NOT o.is_deleted AND o.name LIKE ${pfx.replace(/[%_]/g, '\\$&') + '%'}
          ${ownerOnly ? db`AND o.owner = ${a.userId}` : db``}
          ${search ? db`AND o.name ILIKE ${search}` : db``}
      )
      SELECT name::text AS name, id, size_bytes, mime_type::text AS mime_type, etag::text AS etag, owner, created_at, updated_at, metadata, false AS is_folder
      FROM scoped WHERE position('/' in rest) = 0
      UNION ALL
      SELECT DISTINCT ${pfx}::text || split_part(rest, '/', 1) AS name, NULL::uuid, NULL::bigint, NULL::text, NULL::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::jsonb, true
      FROM scoped WHERE position('/' in rest) > 0
      ORDER BY is_folder DESC, ${db(col === 'size_bytes' ? 'size_bytes' : col)} ${dir}
      LIMIT ${q.data.limit} OFFSET ${q.data.offset}`;
    return reply.send(rows.map((r) => ({
      name: (r['name'] as string).slice(pfx.length), full_path: r['name'], id: r['id'], is_folder: r['is_folder'],
      created_at: r['created_at'], updated_at: r['updated_at'],
      metadata: r['is_folder'] ? null : { size: Number(r['size_bytes']), mimetype: r['mime_type'], eTag: r['etag'], owner: r['owner'], ...(r['metadata'] as object ?? {}) },
    })));
  } catch (err) { return fail(reply, err); }
});

for (const op of ['move', 'copy'] as const) {
  server.post(`/v1/:projectId/object/${op}`, async (req, reply) => {
    try {
      const a = await ctx(req);
      const body = z.object({ bucketId: z.string(), sourceKey: z.string(), destinationKey: z.string(), destinationBucket: z.string().optional() }).safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'Body: { bucketId, sourceKey, destinationKey }');
      const src = await getBucket(a.project.id, body.data.bucketId);
      const dst = body.data.destinationBucket ? await getBucket(a.project.id, body.data.destinationBucket) : src;
      const from = validPath(body.data.sourceKey);
      const to = validPath(body.data.destinationKey);
      const obj = await findObject(src, from);
      if (!obj || !canRead(a, src, obj['owner'] as string | null)) throw new HttpError(404, 'Source object not found');
      if (!canWrite(a, dst, (await findObject(dst, to))?.['owner'] as string | null | undefined) || (op === 'move' && !canWrite(a, src, obj['owner'] as string | null))) {
        throw new HttpError(403, `Not allowed to ${op} this object`);
      }
      if (op === 'copy') await assertStorageQuota(a.project, Number(obj['size_bytes']), Number((await findObject(dst, to))?.['size_bytes'] ?? 0));
      await backend.copy(storageKey(src, from), storageKey(dst, to));
      await db`
        INSERT INTO storage.objects (bucket_id, name, owner, size_bytes, mime_type, etag, storage_path, metadata)
        VALUES (${dst.id}, ${to}, ${op === 'move' ? obj['owner'] as string | null : a.userId}, ${obj['size_bytes'] as number}, ${obj['mime_type'] as string}, ${obj['etag'] as string}, ${storageKey(dst, to)}, ${db.json(obj['metadata'] as any)})
        ON CONFLICT (bucket_id, name) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, mime_type = EXCLUDED.mime_type, etag = EXCLUDED.etag, storage_path = EXCLUDED.storage_path, is_deleted = false`;
      if (op === 'move') {
        await backend.delete(storageKey(src, from)).catch(() => {});
        await db`DELETE FROM storage.objects WHERE id = ${obj['id'] as string}`;
      }
      return reply.send({ message: op === 'move' ? 'Moved' : 'Copied', Key: `${dst.name}/${to}` });
    } catch (err) { return fail(reply, err); }
  });
}

server.post('/v1/:projectId/object/sign/:bucket/*', async (req, reply) => {
  try {
    const a = await ctx(req);
    const { bucket } = req.params as { bucket: string };
    const path = validPath((req.params as any)['*']);
    const b = await getBucket(a.project.id, bucket);
    const obj = await findObject(b, path);
    if (!obj || !canRead(a, b, obj['owner'] as string | null)) throw new HttpError(404, 'Object not found');
    const body = z.object({ expiresIn: z.number().int().min(1).max(7 * 86400).default(3600), transform: z.record(z.unknown()).optional() }).safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'expiresIn must be between 1 and 604800 seconds');
    const token = await signToken(a.project.id, bucket, path, body.data.expiresIn, body.data.transform);
    await db`
      INSERT INTO storage.signed_urls (object_id, token, expires_at, max_uses, created_by)
      VALUES (${obj['id'] as string}, ${createHash('sha256').update(token).digest('hex')}, NOW() + make_interval(secs => ${body.data.expiresIn}), NULL, ${a.userId})`;
    const rel = `/v1/${a.project.id}/object/sign/${bucket}/${path}?token=${token}`;
    return reply.send({
      // signedURL is relative to the project's storage URL (as Supabase's; storage-js appends it), signedUrl is absolute
      signedURL: rel.replace(`/v1/${a.project.id}`, ''), signedUrl: `${PUBLIC_URL}${STORAGE_PUBLIC_PATH}${rel}`,
      expiresIn: body.data.expiresIn, expiresAt: new Date(Date.now() + body.data.expiresIn * 1000).toISOString(), path,
    });
  } catch (err) { return fail(reply, err); }
});

// Image rendering: public | authenticated | sign
server.get('/v1/:projectId/render/image/:mode/:bucket/*', async (req, reply) => {
  try {
    const { projectId, mode, bucket } = req.params as { projectId: string; mode: string; bucket: string };
    const path = validPath((req.params as any)['*']);
    const q = req.query as Record<string, string>;
    const transform = { width: q['width'], height: q['height'], resize: q['resize'], format: q['format'] ?? 'webp', quality: q['quality'] };
    let b: Bucket;
    let obj: any;
    if (mode === 'public') {
      b = await getBucket(projectId, bucket);
      if (!b.is_public) throw new HttpError(400, 'Bucket is not public');
      obj = await findObject(b, path);
    } else if (mode === 'sign') {
      await verifySigned(q['token'] ?? '', projectId, bucket, path);
      b = await getBucket(projectId, bucket);
      obj = await findObject(b, path);
    } else {
      const a = await ctx(req);
      b = await getBucket(a.project.id, bucket);
      obj = await findObject(b, path);
      if (obj && !canRead(a, b, obj.owner)) obj = null;
    }
    if (!obj) throw new HttpError(404, 'Object not found');
    if (!String(obj.mime_type).startsWith('image/')) throw new HttpError(400, 'Object is not an image');
    return sendObject(req, reply, b, obj, transform);
  } catch (err) { return fail(reply, err); }
});

server.setNotFoundHandler((_req, reply) => { void reply.status(404).send({ error: 'Not Found' }); });
server.setErrorHandler((error, req, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) req.log.error({ err: error }, 'Unhandled error');
  void reply.status(status).send({ error: status >= 500 ? 'Internal Server Error' : error.name, message: status >= 500 ? 'Internal server error' : error.message });
});

await backend.init().catch((err) => server.log.warn({ err: err.message }, 'Storage backend not reachable yet'));

try {
  await server.listen({ port: PORT, host: '0.0.0.0' });
  server.log.info({ port: PORT, backend: backend.name, sharp: !!sharp }, 'Storage API started');
} catch (err) {
  server.log.error(err, 'Failed to start'); process.exit(1);
}

const shutdown = async () => { await server.close(); await db.end({ timeout: 5 }); redis.disconnect(); redisSub.disconnect(); await shutdownTracing(); process.exit(0); };
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
