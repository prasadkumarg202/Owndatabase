/**
 * Core auth helpers: project settings, session issuing, refresh tokens,
 * brute-force protection and audit logging.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { db } from './db.js';
import { redis, redisSub } from './redis.js';
import { config } from '../config.js';
import { PlatformAuth, type ProjectInfo } from './platform-auth.js';
import type { SmsSettings } from './sms.js';
import { limitOf } from './limits.js';
import type { CaptchaSettings } from './captcha.js';

export const platform = new PlatformAuth(db, config.JWT_SECRET, redisSub);

export interface AuthSettings {
  enable_signup: boolean;
  require_email_confirmation: boolean;
  password_min_length: number;
  jwt_expiry: number;
  enable_magic_link: boolean;
  /** signInAnonymously(): users without email / phone until they add one */
  enable_anonymous_sign_ins: boolean;
  enable_mfa: boolean;
  /** SMS codes as a second factor (docs/mfa.md) */
  enable_mfa_phone: boolean;
  max_failed_logins: number;
  lockout_minutes: number;
  site_url: string;
  redirect_urls: string[];
  providers: Record<string, { enabled?: boolean; client_id?: string; client_secret?: string }>;
  /** Phone sign-up/sign-in (SMS OTP and phone + password) */
  enable_phone_auth: boolean;
  sms_otp_expiry_minutes: number;
  sms: SmsSettings;
  /** bot protection on sign-up, sign-in, OTP and recovery */
  captcha: CaptchaSettings;
}

export const DEFAULT_SETTINGS: AuthSettings = {
  enable_signup: true, require_email_confirmation: false, password_min_length: 8, jwt_expiry: 3600,
  enable_magic_link: true, enable_anonymous_sign_ins: false, enable_mfa: true, enable_mfa_phone: false, max_failed_logins: 5, lockout_minutes: 15,
  site_url: '', redirect_urls: [], providers: {},
  // 0 = the platform default (SMS_OTP_EXPIRY_MINUTES, else 10)
  enable_phone_auth: false, sms_otp_expiry_minutes: 0, sms: {}, captcha: {},
};

export function authSettings(project: ProjectInfo): AuthSettings {
  const s = { ...DEFAULT_SETTINGS, ...(project.settings?.['auth'] ?? {}) } as AuthSettings;
  s.jwt_expiry = Number(s.jwt_expiry) || config.JWT_EXPIRES_IN;
  return s;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const ARGON2 = { type: 2 /* argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export interface UserRow {
  id: string; email: string | null; phone: string | null; role: string; email_verified: boolean; phone_verified: boolean; is_anonymous: boolean;
  raw_user_meta_data: Record<string, unknown>; raw_app_meta_data: Record<string, unknown>;
  created_at: Date; updated_at?: Date; last_sign_in_at: Date | null; banned_until: Date | null; confirmed_at: Date | null;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id, email: u.email, phone: u.phone, role: u.role, email_verified: u.email_verified, phone_verified: u.phone_verified,
    is_anonymous: !!u.is_anonymous,
    user_metadata: u.raw_user_meta_data ?? {}, app_metadata: u.raw_app_meta_data ?? {},
    created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, confirmed_at: u.confirmed_at,
    // GoTrue fields the Supabase clients expect
    aud: 'authenticated', updated_at: u.updated_at ?? u.created_at,
    email_confirmed_at: u.email && u.email_verified ? (u.confirmed_at ?? u.created_at) : null,
    phone_confirmed_at: u.phone && u.phone_verified ? (u.confirmed_at ?? u.created_at) : null,
  };
}

export async function audit(projectId: string, event: string, req: FastifyRequest, userId: string | null, sessionId: string | null = null, metadata: Record<string, unknown> = {}) {
  await db`
    INSERT INTO auth.auth_audit_log (project_id, event_type, user_id, session_id, ip_address, user_agent, metadata)
    VALUES (${projectId}, ${event}, ${userId}, ${sessionId}, ${req.ip}, ${req.headers['user-agent'] ?? null}, ${db.json(metadata as any)})`;
  const day = new Date().toISOString().slice(0, 10);
  await redis.hincrby(`odb:usage:${projectId}:${day}`, `auth_${event}`, 1).catch(() => {});
}

async function mfaFactorsVerified(userId: string): Promise<boolean> {
  const [f] = await db`SELECT 1 FROM auth.mfa_factors WHERE user_id = ${userId} AND status = 'verified' LIMIT 1`;
  return !!f;
}

/** Creates a session + refresh token and returns the token response. */
export async function issueSession(project: ProjectInfo, user: UserRow, req: FastifyRequest, opts: { aal?: 'aal1' | 'aal2'; sessionId?: string; amr?: string } = {}) {
  const settings = authSettings(project);
  const aal = opts.aal ?? 'aal1';
  let sessionId = opts.sessionId;
  if (!sessionId) {
    const [s] = await db`
      INSERT INTO auth.sessions (project_id, user_id, ip_address, user_agent, not_after, aal)
      VALUES (${project.id}, ${user.id}, ${req.ip}, ${req.headers['user-agent'] ?? null},
              NOW() + make_interval(secs => ${config.REFRESH_TOKEN_EXPIRES_IN}), ${aal})
      RETURNING id`;
    sessionId = s!['id'] as string;
  } else {
    await db`UPDATE auth.sessions SET aal = ${aal}, refreshed_at = NOW() WHERE id = ${sessionId}`;
  }
  const refreshToken = randomBytes(32).toString('base64url');
  await db`INSERT INTO auth.refresh_tokens (session_id, user_id, token) VALUES (${sessionId}, ${user.id}, ${sha256(refreshToken)})`;
  await db`UPDATE auth.users SET last_sign_in_at = NOW() WHERE id = ${user.id}`;

  const accessToken = await platform.signUserToken({
    sub: user.id,
    email: user.email,
    phone: user.phone,
    role: 'authenticated',
    user_role: user.role,
    project_id: project.id,
    session_id: sessionId,
    is_anonymous: !!user.is_anonymous,
    aal,
    amr: [{ method: opts.amr ?? 'password', timestamp: Math.floor(Date.now() / 1000) }],
    app_metadata: user.raw_app_meta_data ?? {},
    user_metadata: user.raw_user_meta_data ?? {},
  }, settings.jwt_expiry);

  const needsMfa = aal === 'aal1' && settings.enable_mfa && (await mfaFactorsVerified(user.id));
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: settings.jwt_expiry,
    expires_at: Math.floor(Date.now() / 1000) + settings.jwt_expiry,
    refresh_token: refreshToken,
    user: publicUser(user),
    session_id: sessionId,
    aal,
    ...(needsMfa ? { mfa_required: true } : {}),
  };
}

export async function getUserById(projectId: string, userId: string): Promise<UserRow | null> {
  const [u] = await db<UserRow[]>`
    SELECT * FROM auth.users WHERE id = ${userId} AND project_id = ${projectId} AND deleted_at IS NULL`;
  return u ?? null;
}

export async function getUserByEmail(projectId: string, email: string): Promise<UserRow | null> {
  const [u] = await db<UserRow[]>`
    SELECT * FROM auth.users WHERE project_id = ${projectId} AND lower(email) = lower(${email}) AND deleted_at IS NULL`;
  return u ?? null;
}

/** The project's auth_users limit, if reached: an error message, else null. */
export async function userQuotaError(project: ProjectInfo): Promise<string | null> {
  const max = limitOf(project, 'auth_users');
  if (max === null) return null;
  const [r] = await db`SELECT count(*)::int AS n FROM auth.users WHERE project_id = ${project.id} AND deleted_at IS NULL`;
  return Number(r?.['n'] ?? 0) >= max ? `This project has reached its limit of ${max} users` : null;
}

export async function getUserByPhone(projectId: string, phone: string): Promise<UserRow | null> {
  const [u] = await db<UserRow[]>`
    SELECT * FROM auth.users WHERE project_id = ${projectId} AND phone = ${phone} AND deleted_at IS NULL`;
  return u ?? null;
}

// ── Brute force / rate limiting (Redis) ─────────────────────────────────────

export async function isLocked(projectId: string, email: string): Promise<number> {
  const ttl = await redis.ttl(`auth:lock:${projectId}:${email.toLowerCase()}`);
  return ttl > 0 ? ttl : 0;
}

export async function recordFailedLogin(project: ProjectInfo, email: string): Promise<boolean> {
  const s = authSettings(project);
  const key = `auth:fail:${project.id}:${email.toLowerCase()}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, s.lockout_minutes * 60);
  if (n >= s.max_failed_logins) {
    await redis.set(`auth:lock:${project.id}:${email.toLowerCase()}`, '1', 'EX', s.lockout_minutes * 60);
    await redis.del(key);
    return true;
  }
  return false;
}

export async function clearFailedLogins(projectId: string, email: string) {
  await redis.del(`auth:fail:${projectId}:${email.toLowerCase()}`);
}

/** Fixed-window limiter. Returns true when the call is allowed. */
export async function allow(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = `auth:rl:${bucket}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSeconds);
  return n <= max;
}

export function isAllowedRedirect(settings: AuthSettings, url: string | undefined): boolean {
  if (!url) return false;
  const allowed = [settings.site_url, config.SITE_URL, ...(settings.redirect_urls ?? [])].filter(Boolean);
  return allowed.some((a) => url === a || url.startsWith(a.replace(/\/$/, '') + '/') || (a.endsWith('*') && url.startsWith(a.slice(0, -1))));
}
