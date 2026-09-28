/**
 * Shared data-plane authentication helpers.
 *
 * CANONICAL COPY: platform/shared/platform-auth.ts
 * Copied into each data-plane service by `scripts/sync-shared.sh` because
 * every service has its own Docker build context. Edit the canonical copy.
 *
 * Every data-plane request must carry a project API key (`apikey` header,
 * `x-api-key` header or `?apikey=`). An optional `Authorization: Bearer <jwt>`
 * issued by the auth service upgrades the request to the signed-in user.
 */

import { createHash } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';

export type ApiRole = 'anon' | 'authenticated' | 'service_role';

export interface ProjectInfo {
  id: string;
  slug: string;
  status: string;
  db_schema: string;
  settings: Record<string, any>;
}

export interface KeyInfo {
  id: string;
  project_id: string;
  type: 'anon' | 'authenticated' | 'service_role' | 'admin';
}

export interface RequestAuth {
  project: ProjectInfo;
  key: KeyInfo;
  role: ApiRole;
  claims: Record<string, any> | null;
  userId: string | null;
}

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const TTL_MS = 30_000;

export class PlatformAuth {
  private keyCache = new Map<string, { value: KeyInfo | null; exp: number }>();
  private projectCache = new Map<string, { value: ProjectInfo | null; exp: number }>();
  private secret: Uint8Array;

  constructor(private db: postgres.Sql<any>, jwtSecret: string, subscriber?: Redis) {
    this.secret = new TextEncoder().encode(jwtSecret);
    if (subscriber) {
      void subscriber.subscribe('odb:apikey-revoked', 'odb:project-changed').catch(() => {});
      subscriber.on('message', (channel: string, msg: string) => {
        if (channel === 'odb:apikey-revoked') this.keyCache.delete(msg);
        if (channel === 'odb:project-changed') this.projectCache.delete(msg);
      });
    }
  }

  static hashKey(key: string) {
    return createHash('sha256').update(key).digest('hex');
  }

  async getProject(projectId: string): Promise<ProjectInfo | null> {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
    const hit = this.projectCache.get(projectId);
    if (hit && hit.exp > Date.now()) return hit.value;
    const [row] = await this.db`
      SELECT id, slug, status::text AS status, db_schema, settings FROM control_plane.projects WHERE id = ${projectId}`;
    const value = (row as ProjectInfo | undefined) ?? null;
    this.projectCache.set(projectId, { value, exp: Date.now() + TTL_MS });
    return value;
  }

  async getKey(rawKey: string): Promise<KeyInfo | null> {
    const hash = PlatformAuth.hashKey(rawKey);
    const hit = this.keyCache.get(hash);
    if (hit && hit.exp > Date.now()) return hit.value;
    const [row] = await this.db`
      UPDATE control_plane.api_keys SET last_used_at = NOW()
      WHERE key_hash = ${hash} AND is_active AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id, project_id, type::text AS type`;
    const value = (row as KeyInfo | undefined) ?? null;
    this.keyCache.set(hash, { value, exp: Date.now() + TTL_MS });
    return value;
  }

  async verifyUserToken(token: string, projectId: string): Promise<Record<string, any>> {
    const { payload } = await jwtVerify(token, this.secret, { issuer: 'owndatabase-auth', algorithms: ['HS256'] });
    if (payload['project_id'] !== projectId) throw new AuthError(401, 'Token was issued for a different project');
    if (payload['typ'] && payload['typ'] !== 'access') throw new AuthError(401, 'Not an access token');
    return payload as Record<string, any>;
  }

  async signUserToken(claims: Record<string, any>, expiresInSeconds: number): Promise<string> {
    return new SignJWT({ ...claims, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('owndatabase-auth')
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
      .sign(this.secret);
  }

  /** Signs a short-lived internal token used between platform services. */
  async signInternal(claims: Record<string, any>, seconds = 60): Promise<string> {
    return new SignJWT({ ...claims, typ: 'internal' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('owndatabase-internal')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
      .sign(this.secret);
  }

  async verifyInternal(token: string): Promise<Record<string, any>> {
    const { payload } = await jwtVerify(token, this.secret, { issuer: 'owndatabase-internal', algorithms: ['HS256'] });
    return payload as Record<string, any>;
  }

  static extractApiKey(headers: Record<string, any>, query: Record<string, any> = {}): string | null {
    const h = headers['apikey'] ?? headers['x-api-key'] ?? query['apikey'];
    if (typeof h === 'string' && h.length > 10) return h;
    const bearer = PlatformAuth.extractBearer(headers);
    if (bearer && bearer.startsWith('odb_')) return bearer;
    return null;
  }

  static extractBearer(headers: Record<string, any>): string | null {
    const auth = headers['authorization'];
    if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    return null;
  }

  /**
   * Resolves project, key and (optional) user for a data-plane request.
   * Throws AuthError with the right HTTP status on failure.
   */
  /**
   * Dashboard (platform) users may manage a project's data-plane resources
   * with their control-plane token when they belong to the project's org.
   */
  async platformUserAccess(token: string, projectId: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] });
      if (payload['role'] !== 'platform_user' || typeof payload['sub'] !== 'string') return null;
      const [m] = await this.db`
        SELECT om.role FROM control_plane.projects p
        JOIN control_plane.organization_members om ON om.organization_id = p.organization_id
        WHERE p.id = ${projectId} AND om.user_id = ${payload['sub']} AND om.role IN ('owner','admin','developer')`;
      return m ? (payload['sub'] as string) : null;
    } catch {
      return null;
    }
  }

  async authenticate(projectId: string, headers: Record<string, any>, query: Record<string, any> = {}, opts: { requireKey?: boolean; allowPlatformUser?: boolean } = {}): Promise<RequestAuth> {
    const project = await this.getProject(projectId);
    if (!project || project.status === 'deleting') throw new AuthError(404, 'Project not found');
    if (project.status === 'paused') throw new AuthError(503, 'Project is paused');

    const rawKey = PlatformAuth.extractApiKey(headers, query);
    if (!rawKey && opts.allowPlatformUser) {
      const bearer = PlatformAuth.extractBearer(headers);
      const uid = bearer ? await this.platformUserAccess(bearer, projectId) : null;
      if (uid) {
        return { project, key: { id: `platform:${uid}`, project_id: projectId, type: 'service_role' }, role: 'service_role', claims: { role: 'service_role', platform_user: uid }, userId: null };
      }
    }
    let key: KeyInfo | null = null;
    if (rawKey) {
      key = await this.getKey(rawKey);
      if (!key || key.project_id !== projectId) throw new AuthError(401, 'Invalid API key');
    } else if (opts.requireKey !== false) {
      throw new AuthError(401, 'Missing API key. Send it in the `apikey` header.');
    }

    let role: ApiRole = key && (key.type === 'service_role' || key.type === 'admin') ? 'service_role' : 'anon';
    let claims: Record<string, any> | null = null;

    const bearer = PlatformAuth.extractBearer(headers);
    if (bearer && !bearer.startsWith('odb_')) {
      try {
        claims = await this.verifyUserToken(bearer, projectId);
      } catch (err) {
        throw new AuthError(401, err instanceof AuthError ? err.message : 'Invalid or expired access token');
      }
      if (role !== 'service_role') role = 'authenticated';
    }

    return {
      project,
      key: key ?? { id: 'jwt', project_id: projectId, type: 'authenticated' },
      role,
      claims: claims ?? (role === 'service_role' ? { role: 'service_role' } : { role: 'anon' }),
      userId: (claims?.['sub'] as string | undefined) ?? null,
    };
  }
}

/** Runs `fn` inside a transaction as the given API role with JWT claims set for RLS. */
export async function withRole<T>(
  sql: postgres.Sql<any>,
  auth: Pick<RequestAuth, 'role' | 'claims' | 'project'>,
  fn: (tx: postgres.TransactionSql<any>) => Promise<T>,
  statementTimeoutMs = 15000,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${auth.role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(auth.claims ?? {})}, true),
                    set_config('request.jwt.claim.sub', ${String(auth.claims?.['sub'] ?? '')}, true),
                    set_config('search_path', ${'"' + auth.project.db_schema.replace(/"/g, '""') + '", public'}, true),
                    set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
