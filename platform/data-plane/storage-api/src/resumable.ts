/**
 * Resumable uploads — TUS 1.0.0 (creation, creation-with-upload, termination, expiration), the protocol
 * Supabase Storage uses at /storage/v1/upload/resumable (tus-js-client, Uppy):
 *
 *   POST   /v1/:projectId/upload/resumable        Upload-Length, Upload-Metadata (bucketName, objectName,
 *                                                  contentType, cacheControl, metadata), x-upsert → 201 Location
 *   HEAD   /v1/:projectId/upload/resumable/:id    → Upload-Offset / Upload-Length (resume after a drop)
 *   PATCH  /v1/:projectId/upload/resumable/:id    Upload-Offset + application/offset+octet-stream chunk
 *   DELETE /v1/:projectId/upload/resumable/:id    cancel
 *
 * Every chunk is streamed to the backend as its own piece (no memory buffering); when the last byte
 * arrives the pieces are streamed into the final object and it appears in the bucket like any upload.
 * Permissions, size limits, MIME types and quota are checked when the upload starts and again at the end.
 * Only the key / user that started an upload can continue it. Unfinished uploads expire after
 * RESUMABLE_EXPIRY_HOURS (24).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type postgres from 'postgres';
import type { StorageBackend } from './lib/backend.js';
import type { RequestAuth } from './lib/platform-auth.js';

export const RESUMABLE_MAX_SIZE = Number(process.env['RESUMABLE_MAX_SIZE'] ?? 5 * 1024 ** 3);
const EXPIRY_HOURS = Number(process.env['RESUMABLE_EXPIRY_HOURS'] ?? 24);
const TUS_VERSION = '1.0.0';

export interface ResumableDeps {
  db: postgres.Sql<any>;
  backend: StorageBackend;
  publicPath: string;                         // e.g. /storage
  HttpError: new (status: number, message: string) => Error;
  ctx(req: FastifyRequest): Promise<RequestAuth>;
  getBucket(projectId: string, name: string): Promise<any>;
  validPath(p: string | undefined): string;
  canWrite(a: RequestAuth, b: any, existingOwner: string | null | undefined): boolean;
  findObject(b: any, path: string): Promise<any>;
  assertStorageQuota(project: RequestAuth['project'], adding: number, replacing?: number): Promise<void>;
  storageKey(b: any, path: string): string;
  mimeAllowed(b: any, mime: string): boolean;
  onUploaded(projectId: string, bytes: number): Promise<void>;
  fail(reply: FastifyReply, err: unknown): unknown;
}

/** Upload-Metadata: "key base64value,key2 base64value2" */
function parseMetadata(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of String(h ?? '').split(',')) {
    const [k, v] = pair.trim().split(' ');
    if (k) out[k] = v ? Buffer.from(v, 'base64').toString('utf8') : '';
  }
  return out;
}

const whoOf = (a: RequestAuth) => (a.userId ? `u:${a.userId}` : `k:${a.key.id}`);
const chunkKey = (projectId: string, id: string, i: number) => `_resumable/${projectId}/${id}/${i}`;

/** Capability headers for OPTIONS on the upload URLs (added in an onRequest hook before @fastify/cors answers). */
export const TUS_CAPABILITIES: Record<string, string> = {
  'Tus-Resumable': TUS_VERSION, 'Tus-Version': TUS_VERSION,
  'Tus-Extension': 'creation,creation-with-upload,termination,expiration', 'Tus-Max-Size': String(RESUMABLE_MAX_SIZE),
};

export function registerResumable(server: FastifyInstance, d: ResumableDeps) {
  const E = (status: number, msg: string) => new d.HttpError(status, msg);

  // raw chunk bodies: handed over as a stream, limited by the upload's remaining length
  server.addContentTypeParser('application/offset+octet-stream', (_req, payload, done) => done(null, payload));

  const tusHeaders = (reply: FastifyReply) => reply.header('Tus-Resumable', TUS_VERSION).header('Cache-Control', 'no-store');
  const location = (projectId: string, id: string) => `${d.publicPath}/v1/${projectId}/upload/resumable/${id}`;

  async function load(req: FastifyRequest, a: RequestAuth) {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw E(404, 'Upload not found');
    const [u] = await d.db`SELECT * FROM storage.resumable_uploads WHERE id = ${id} AND project_id = ${a.project.id}`;
    // another key / user cannot see or continue someone else's upload
    if (!u || u['owner_key'] !== whoOf(a)) throw E(404, 'Upload not found');
    if (new Date(u['expires_at']) < new Date()) throw E(410, 'Upload expired');
    return u;
  }

  async function removeChunks(projectId: string, id: string, count: number) {
    for (let i = 0; i < count; i++) await d.backend.delete(chunkKey(projectId, id, i)).catch(() => {});
  }

  /** Writes one chunk; returns the new offset (and finishes the upload when complete). */
  async function appendChunk(a: RequestAuth, u: any, body: Readable | undefined, offset: number): Promise<number> {
    if (offset !== Number(u['upload_offset'])) throw E(409, `Upload-Offset ${offset} does not match the current offset ${u['upload_offset']}`);
    const remaining = Number(u['upload_length']) - offset;
    // one PATCH at a time per upload
    const [locked] = await d.db`
      UPDATE storage.resumable_uploads SET locked_until = NOW() + INTERVAL '10 minutes'
      WHERE id = ${u['id']} AND (locked_until IS NULL OR locked_until < NOW()) AND upload_offset = ${offset} RETURNING id`;
    if (!locked) throw E(423, 'Another request is uploading to this upload');
    const index = (u['chunk_sizes'] as unknown[]).length;
    let written = 0;
    try {
      if (body && remaining > 0) {
        async function* limited() {
          for await (const c of body as AsyncIterable<Buffer>) {
            written += c.length;
            if (written > remaining) throw E(413, 'The chunk is longer than the rest of the upload');
            yield c;
          }
        }
        written = 0;
        const n = await d.backend.putStream(chunkKey(a.project.id, u['id'], index), limited(), 'application/octet-stream');
        written = n;
      }
      const next = offset + written;
      await d.db`
        UPDATE storage.resumable_uploads SET upload_offset = ${next}, locked_until = NULL,
          chunk_sizes = CASE WHEN ${written} > 0 THEN array_append(chunk_sizes, ${written}::bigint) ELSE chunk_sizes END
        WHERE id = ${u['id']}`;
      if (next === Number(u['upload_length'])) await finish(a, { ...u, upload_offset: next, chunk_sizes: written > 0 ? [...u['chunk_sizes'], written] : u['chunk_sizes'] });
      return next;
    } catch (err) {
      if (written > 0) await d.backend.delete(chunkKey(a.project.id, u['id'], index)).catch(() => {});
      await d.db`UPDATE storage.resumable_uploads SET locked_until = NULL WHERE id = ${u['id']}`;
      throw err;
    }
  }

  /** All bytes are in: stream the chunks into the object and register it. */
  async function finish(a: RequestAuth, u: any) {
    const b = await d.getBucket(a.project.id, (await d.db`SELECT name FROM storage.buckets WHERE id = ${u['bucket_id']}`)[0]?.['name']);
    const existing = await d.findObject(b, u['name']);
    if (existing && !u['upsert']) throw E(409, 'The object already exists. Send x-upsert: true to overwrite.');
    if (!d.canWrite(a, b, existing ? existing['owner'] : undefined)) throw E(403, 'Not allowed to write to this bucket');
    await d.assertStorageQuota(a.project, Number(u['upload_length']), existing ? Number(existing['size_bytes']) : 0);

    const md5 = createHash('md5');
    const count = (u['chunk_sizes'] as unknown[]).length;
    const backend = d.backend;
    async function* all() {
      for (let i = 0; i < count; i++) {
        const o = await backend.get(chunkKey(a.project.id, u['id'], i));
        if (!o) throw new Error(`Chunk ${i} of upload ${u['id']} is missing`);
        for await (const c of o.stream as AsyncIterable<Buffer>) { md5.update(c); yield c; }
      }
    }
    const key = d.storageKey(b, u['name']);
    const size = await backend.putStream(key, all(), u['mime_type']);
    if (size !== Number(u['upload_length'])) throw E(500, `Assembled ${size} of ${u['upload_length']} bytes`);
    const meta = { ...(u['user_metadata'] ?? {}), ...(u['cache_control'] ? { cacheControl: u['cache_control'] } : {}) };
    await d.db`
      INSERT INTO storage.objects (bucket_id, name, owner, size_bytes, mime_type, etag, storage_path, metadata)
      VALUES (${b.id}, ${u['name']}, ${u['owner']}, ${size}, ${u['mime_type']}, ${md5.digest('hex')}, ${key}, ${d.db.json(meta)})
      ON CONFLICT (bucket_id, name) DO UPDATE SET
        size_bytes = EXCLUDED.size_bytes, mime_type = EXCLUDED.mime_type, etag = EXCLUDED.etag,
        storage_path = EXCLUDED.storage_path, metadata = EXCLUDED.metadata, is_deleted = false,
        owner = COALESCE(storage.objects.owner, EXCLUDED.owner)`;
    await d.db`DELETE FROM storage.resumable_uploads WHERE id = ${u['id']}`;
    await removeChunks(a.project.id, u['id'], count);
    await d.onUploaded(a.project.id, size);
  }

  server.post('/v1/:projectId/upload/resumable', async (req, reply) => {
    try {
      const a = await d.ctx(req);
      const version = req.headers['tus-resumable'];
      if (version && version !== TUS_VERSION) return tusHeaders(reply).header('Tus-Version', TUS_VERSION).status(412).send();
      if (req.headers['upload-defer-length']) throw E(400, 'Upload-Defer-Length is not supported: send Upload-Length');
      const length = Number(req.headers['upload-length']);
      if (!Number.isSafeInteger(length) || length < 0) throw E(400, 'Upload-Length is required');
      const m = parseMetadata(req.headers['upload-metadata']);
      if (!m['bucketName'] || !m['objectName']) throw E(400, 'Upload-Metadata needs bucketName and objectName');
      const b = await d.getBucket(a.project.id, m['bucketName']);
      const path = d.validPath(m['objectName']);
      const mime = (m['contentType'] || 'application/octet-stream').split(';')[0]!.trim();

      if (length > RESUMABLE_MAX_SIZE) throw E(413, `Upload-Length exceeds the ${RESUMABLE_MAX_SIZE} byte limit`);
      if (b.file_size_limit && length > Number(b.file_size_limit)) throw E(413, `File size ${length} exceeds the bucket limit of ${b.file_size_limit} bytes`);
      if (!d.mimeAllowed(b, mime)) throw E(415, `MIME type ${mime} is not allowed in this bucket`);
      const upsert = String(req.headers['x-upsert'] ?? '') === 'true';
      const existing = await d.findObject(b, path);
      if (existing && !upsert) throw E(409, 'The object already exists. Send x-upsert: true to overwrite.');
      if (!d.canWrite(a, b, existing ? existing['owner'] : undefined)) throw E(403, 'Not allowed to write to this bucket');
      await d.assertStorageQuota(a.project, length, existing ? Number(existing['size_bytes']) : 0);
      let userMeta: Record<string, unknown> = {};
      if (m['metadata']) { try { userMeta = JSON.parse(m['metadata']); } catch { /* ignore */ } }

      // expired uploads of this project are cleaned up as new ones start
      for (const x of await d.db`SELECT id, cardinality(chunk_sizes) AS n FROM storage.resumable_uploads WHERE project_id = ${a.project.id} AND expires_at < NOW() LIMIT 20`) {
        await removeChunks(a.project.id, x['id'], Number(x['n']));
        await d.db`DELETE FROM storage.resumable_uploads WHERE id = ${x['id']}`;
      }
      const expires = new Date(Date.now() + EXPIRY_HOURS * 3600_000);
      const [u] = await d.db`
        INSERT INTO storage.resumable_uploads (project_id, bucket_id, name, owner, owner_key, upload_length, mime_type, cache_control, user_metadata, upsert, expires_at)
        VALUES (${a.project.id}, ${b.id}, ${path}, ${a.userId}, ${whoOf(a)}, ${length}, ${mime}, ${m['cacheControl'] || null}, ${d.db.json(userMeta as any)}, ${upsert}, ${expires})
        RETURNING *`;
      tusHeaders(reply).header('Location', location(a.project.id, u!['id'])).header('Upload-Expires', expires.toUTCString());
      // creation-with-upload: the first chunk can come with the POST
      if (String(req.headers['content-type'] ?? '').startsWith('application/offset+octet-stream') || length === 0) {
        const offset = await appendChunk(a, u, req.body as Readable | undefined, 0);
        reply.header('Upload-Offset', offset);
      }
      return reply.status(201).send();
    } catch (err) { return d.fail(tusHeaders(reply), err); }
  });

  server.head('/v1/:projectId/upload/resumable/:id', async (req, reply) => {
    try {
      const a = await d.ctx(req);
      const u = await load(req, a);
      return tusHeaders(reply).header('Upload-Offset', Number(u['upload_offset'])).header('Upload-Length', Number(u['upload_length']))
        .header('Upload-Expires', new Date(u['expires_at']).toUTCString()).status(200).send();
    } catch (err) {
      // HEAD responses have no body: just the status
      const status = (err as any)?.status ?? 500;
      return tusHeaders(reply).status(status).send();
    }
  });

  server.patch('/v1/:projectId/upload/resumable/:id', async (req, reply) => {
    try {
      const a = await d.ctx(req);
      if (!String(req.headers['content-type'] ?? '').startsWith('application/offset+octet-stream')) {
        throw E(415, 'Content-Type must be application/offset+octet-stream');
      }
      const offset = Number(req.headers['upload-offset']);
      if (!Number.isSafeInteger(offset) || offset < 0) throw E(400, 'Upload-Offset is required');
      const u = await load(req, a);
      const next = await appendChunk(a, u, req.body as Readable, offset);
      return tusHeaders(reply).header('Upload-Offset', next).status(204).send();
    } catch (err) { return d.fail(tusHeaders(reply), err); }
  });

  server.delete('/v1/:projectId/upload/resumable/:id', async (req, reply) => {
    try {
      const a = await d.ctx(req);
      const u = await load(req, a);
      await d.db`DELETE FROM storage.resumable_uploads WHERE id = ${u['id']}`;
      await removeChunks(a.project.id, u['id'], (u['chunk_sizes'] as unknown[]).length);
      return tusHeaders(reply).status(204).send();
    } catch (err) { return d.fail(tusHeaders(reply), err); }
  });


  // expired uploads everywhere, every 10 minutes
  const sweep = async () => {
    try {
      for (const x of await d.db`SELECT id, project_id, cardinality(chunk_sizes) AS n FROM storage.resumable_uploads WHERE expires_at < NOW() LIMIT 200`) {
        await removeChunks(x['project_id'], x['id'], Number(x['n']));
        await d.db`DELETE FROM storage.resumable_uploads WHERE id = ${x['id']}`;
      }
    } catch { /* next time */ }
  };
  setInterval(sweep, 10 * 60_000).unref();
}
