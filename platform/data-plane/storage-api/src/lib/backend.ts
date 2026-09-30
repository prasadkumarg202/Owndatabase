/**
 * Object storage backends.
 *
 *   STORAGE_BACKEND=fs      files under STORAGE_FS_ROOT (single VPS / development)
 *   STORAGE_BACKEND=s3      any S3-compatible service: MinIO, SeaweedFS, AWS S3,
 *                           Cloudflare R2, Backblaze B2, Wasabi (aliases: minio, r2, b2, wasabi)
 *
 * Objects from every project live in ONE backend bucket, under
 * `<projectId>/<bucketId>/<path>`.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand,
  HeadBucketCommand, CreateBucketCommand, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

export interface StoredObject { stream: Readable; size: number; contentType?: string }

export interface StorageBackend {
  name: string;
  init(): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Writes a stream of any length without holding it in memory; returns the number of bytes written. */
  putStream(key: string, body: AsyncIterable<Buffer>, contentType: string): Promise<number>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  health(): Promise<boolean>;
}

class FsBackend implements StorageBackend {
  name = 'fs';
  constructor(private root: string) {}
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + '/')) throw new Error('Invalid object key');
    return p;
  }
  async init() { await mkdir(this.root, { recursive: true }); }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await pipeline(Readable.from(body), createWriteStream(tmp));
    await rename(tmp, p);
  }
  async putStream(key: string, body: AsyncIterable<Buffer>) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    let n = 0;
    await pipeline(Readable.from((async function* () { for await (const c of body) { n += c.length; yield c; } })()), createWriteStream(tmp));
    await rename(tmp, p);
    return n;
  }
  async get(key: string) {
    const p = this.path(key);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p), size: s.size };
    } catch { return null; }
  }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async copy(from: string, to: string) {
    const t = this.path(to);
    await mkdir(dirname(t), { recursive: true });
    await copyFile(this.path(from), t);
  }
  async health() { try { await stat(this.root); return true; } catch { return false; } }
}

class S3Backend implements StorageBackend {
  name = 's3';
  private s3: S3Client;
  constructor(private bucket: string, opts: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }) {
    this.s3 = new S3Client({
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      region: opts.region, forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }
  async init() {
    try { await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket })).catch(() => {}); }
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  /** S3 multipart upload in PART_SIZE parts (S3 needs >= 5 MiB per part except the last). */
  async putStream(key: string, body: AsyncIterable<Buffer>, contentType: string) {
    const PART_SIZE = 8 * 1024 * 1024;
    let buf: Buffer[] = [], buffered = 0, total = 0, uploadId: string | undefined;
    const parts: { ETag: string; PartNumber: number }[] = [];
    const flush = async (last: boolean) => {
      if (!buffered && !last) return;
      const chunk = Buffer.concat(buf, buffered);
      buf = []; buffered = 0;
      if (!uploadId && last) {  // small object: a single PUT
        await this.put(key, chunk, contentType);
        return;
      }
      if (!uploadId) {
        uploadId = (await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }))).UploadId!;
      }
      if (!chunk.length) return;
      const PartNumber = parts.length + 1;
      const r = await this.s3.send(new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber, Body: chunk }));
      parts.push({ ETag: r.ETag!, PartNumber });
    };
    try {
      for await (const c of body) {
        buf.push(c); buffered += c.length; total += c.length;
        if (buffered >= PART_SIZE) await flush(false);
      }
      await flush(true);
      if (uploadId) await this.s3.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
      return total;
    } catch (err) {
      if (uploadId) await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => {});
      throw err;
    }
  }
  async get(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { stream: r.Body as Readable, size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async delete(key: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async copy(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${encodeURI(from)}` }));
  }
  async health() { try { await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket })); return true; } catch { return false; } }
}

export function createBackend(): StorageBackend {
  const kind = (process.env['STORAGE_BACKEND'] ?? 'fs').toLowerCase();
  if (kind === 'fs' || kind === 'local') return new FsBackend(process.env['STORAGE_FS_ROOT'] ?? join(process.cwd(), 'data'));
  return new S3Backend(process.env['S3_BUCKET'] ?? 'owndatabase', {
    endpoint: process.env['S3_ENDPOINT'] || undefined,
    region: process.env['S3_REGION'] ?? 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? '',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? '',
    forcePathStyle: (process.env['S3_FORCE_PATH_STYLE'] ?? 'true') === 'true',
  });
}
