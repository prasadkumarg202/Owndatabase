/**
 * Platform Authentication Routes (dashboard users, not app end-users)
 *
 * POST /api/auth/signup    — Register a platform user (+ personal organization)
 * POST /api/auth/login     — Login and receive access + refresh tokens
 * POST /api/auth/refresh   — Rotate refresh token, get a new access token
 * POST /api/auth/logout    — Revoke current session (?all=true for all devices)
 * GET  /api/auth/me        — Current user profile
 * GET  /api/auth/sessions  — Active sessions
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { audit, userId } from '../lib/access.js';

const signupSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  name: z.string().min(1).max(255).trim().optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(128),
});

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// A real hash of a random string, so failed lookups cost the same as real ones.
const DUMMY_HASH_PROMISE = argon2.hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
}

export const authRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  async function issueTokens(user: { id: string; email: string }, request: any) {
    const refreshToken = randomBytes(48).toString('hex');
    const [session] = await db`
      INSERT INTO control_plane.platform_sessions (user_id, token_hash, refresh_token_hash, ip_address, user_agent, expires_at)
      VALUES (${user.id}, ${sha256(randomBytes(16).toString('hex'))}, ${sha256(refreshToken)}, ${request.ip},
              ${request.headers['user-agent'] ?? null}, NOW() + make_interval(secs => ${config.refreshTokenExpiresIn}))
      RETURNING id
    `;
    const accessToken = server.jwt.sign(
      { sub: user.id, email: user.email, role: 'platform_user', sid: session!['id'] },
      { expiresIn: config.jwtExpiresIn },
    );
    return { accessToken, refreshToken, sessionId: session!['id'] as string };
  }

  server.post('/signup', {
    schema: { tags: ['auth'], summary: 'Register a new platform user' },
  }, async (request, reply) => {
    const input = signupSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    }
    const { email, password, name } = input.data;

    const [existing] = await db`SELECT id FROM control_plane.platform_users WHERE email = ${email}`;
    if (existing) {
      return reply.status(409).send({ error: 'Conflict', message: 'An account with this email already exists' });
    }

    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

    const user = await db.begin(async (sql) => {
      const [u] = await sql`
        -- the very first account administers the platform
        INSERT INTO control_plane.platform_users (email, name, password_hash, is_platform_admin)
        VALUES (${email}, ${name ?? null}, ${passwordHash}, NOT EXISTS (SELECT 1 FROM control_plane.platform_users))
        RETURNING id, email, name, created_at
      `;
      // Every user gets a personal organization so they can create projects immediately
      const base = slugify(email.split('@')[0] ?? 'org');
      const slug = `${base}-${randomBytes(3).toString('hex')}`;
      const [org] = await sql`
        INSERT INTO control_plane.organizations (name, slug)
        VALUES (${(name ?? email.split('@')[0]) + "'s Organization"}, ${slug})
        RETURNING id
      `;
      await sql`
        INSERT INTO control_plane.organization_members (organization_id, user_id, role, joined_at, invited_by)
        VALUES (${org!['id']}, ${u!['id']}, 'owner', NOW(), ${u!['id']})
      `;
      return { ...u!, organization_id: org!['id'] } as Record<string, any>;
    });

    await audit(request, 'user.signup', { type: 'platform_user', id: user['id'] as string }, { email });
    logger.info({ userId: user['id'] }, 'Platform user registered');
    return reply.status(201).send(user);
  });

  server.post('/login', {
    config: { rateLimit: { max: config.loginRateLimitMax, timeWindow: '15 minutes' } },
    schema: { tags: ['auth'], summary: 'Login with email and password' },
  }, async (request, reply) => {
    const input = loginSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'Invalid input' });
    const { email, password } = input.data;

    const [user] = await db`
      SELECT id, email, name, password_hash, is_active FROM control_plane.platform_users WHERE email = ${email}
    `;

    const hash = (user?.['password_hash'] as string | undefined) ?? await DUMMY_HASH_PROMISE;
    let valid = false;
    try { valid = await argon2.verify(hash, password); } catch { valid = false; }

    if (!user || !valid) {
      if (user) await audit(request, 'user.login_failed', { type: 'platform_user', id: user['id'] as string }, { email });
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid email or password' });
    }
    if (!user['is_active']) return reply.status(403).send({ error: 'Forbidden', message: 'Account is disabled' });

    const tokens = await issueTokens({ id: user['id'] as string, email: user['email'] as string }, request);
    await db`UPDATE control_plane.platform_users SET last_login_at = NOW() WHERE id = ${user['id'] as string}`;
    await audit(request, 'user.login', { type: 'platform_session', id: tokens.sessionId });

    return reply.send({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: 'bearer',
      expires_in: config.jwtExpiresIn,
      user: { id: user['id'], email: user['email'], name: user['name'] },
    });
  });

  server.post('/refresh', { schema: { tags: ['auth'], summary: 'Rotate refresh token' } }, async (request, reply) => {
    const body = z.object({ refresh_token: z.string().min(10) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation Error', message: 'refresh_token is required' });

    const [session] = await db`
      SELECT s.id, s.user_id, s.revoked_at, s.expires_at, u.email, u.is_active
      FROM control_plane.platform_sessions s
      JOIN control_plane.platform_users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ${sha256(body.data.refresh_token)}
    `;
    if (!session || session['revoked_at'] || new Date(session['expires_at'] as string) < new Date() || !session['is_active']) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired refresh token' });
    }
    // Rotation: the old refresh token dies with its session
    await db`UPDATE control_plane.platform_sessions SET revoked_at = NOW() WHERE id = ${session['id'] as string}`;
    await redis.set(`cp:revoked:${session['id']}`, '1', 'EX', config.jwtExpiresIn);
    const tokens = await issueTokens({ id: session['user_id'] as string, email: session['email'] as string }, request);
    return reply.send({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: 'bearer',
      expires_in: config.jwtExpiresIn,
    });
  });

  server.post('/logout', {
    preValidation: [server.authenticate],
    schema: { tags: ['auth'], summary: 'Logout (current session, or all with ?all=true)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const uid = userId(request);
    const sid = (request.user as { sid?: string }).sid;
    const all = (request.query as { all?: string }).all === 'true';
    const rows = all
      ? await db`UPDATE control_plane.platform_sessions SET revoked_at = NOW() WHERE user_id = ${uid} AND revoked_at IS NULL RETURNING id`
      : await db`UPDATE control_plane.platform_sessions SET revoked_at = NOW() WHERE id = ${sid ?? null} AND user_id = ${uid} RETURNING id`;
    for (const r of rows) await redis.set(`cp:revoked:${r['id']}`, '1', 'EX', config.jwtExpiresIn);
    await audit(request, all ? 'user.logout_all' : 'user.logout', { type: 'platform_user', id: uid });
    return reply.send({ success: true, revoked: rows.length });
  });

  server.get('/me', {
    preValidation: [server.authenticate],
    schema: { tags: ['auth'], summary: 'Get current user profile', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const [user] = await db`
      SELECT id, email, name, is_verified, mfa_enabled, avatar_url, last_login_at, created_at,
             (is_platform_admin OR lower(email) = ANY(${config.platformAdminEmails})) AS is_platform_admin
      FROM control_plane.platform_users WHERE id = ${userId(request)}
    `;
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    return reply.send(user);
  });

  server.get('/sessions', {
    preValidation: [server.authenticate],
    schema: { tags: ['auth'], summary: 'List active sessions', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const sid = (request.user as { sid?: string }).sid;
    const rows = await db`
      SELECT id, ip_address, user_agent, created_at, expires_at, (id = ${sid ?? null}) AS current
      FROM control_plane.platform_sessions
      WHERE user_id = ${userId(request)} AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC
    `;
    return reply.send({ data: rows });
  });
};
