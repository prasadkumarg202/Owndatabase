/**
 * End-user management for a project (the dashboard "Authentication" page).
 *
 *   GET    /api/projects/:id/users
 *   POST   /api/projects/:id/users
 *   GET    /api/projects/:id/users/:userId
 *   PATCH  /api/projects/:id/users/:userId
 *   DELETE /api/projects/:id/users/:userId
 *   DELETE /api/projects/:id/users/:userId/sessions
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/db.js';
import { ADMIN_ROLES, audit, requireProject, WRITE_ROLES } from '../lib/access.js';

const ARGON2 = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const UUID = /^[0-9a-f-]{36}$/i;

export const projectUserRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (summary: string) => ({ schema: { tags: ['project-users'], summary, security: [{ bearerAuth: [] }] } });

  server.get('/:id/users', { ...auth, ...s('List end users') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const q = request.query as { search?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit) || 50, 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const search = q.search ? `%${q.search}%` : null;
    const users = await db`
      SELECT u.id, u.email, u.phone, u.role, u.email_verified, u.is_anonymous, u.banned_until, u.created_at,
             u.last_sign_in_at, u.raw_user_meta_data AS user_metadata, u.raw_app_meta_data AS app_metadata,
             COALESCE((SELECT array_agg(DISTINCT i.provider) FROM auth.identities i WHERE i.user_id = u.id), '{}') AS providers,
             EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified') AS mfa_enabled
      FROM auth.users u
      WHERE u.project_id = ${id} AND u.deleted_at IS NULL
        ${search ? db`AND (u.email ILIKE ${search} OR u.phone ILIKE ${search})` : db``}
      ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const [{ total }] = await db`
      SELECT count(*)::int AS total FROM auth.users WHERE project_id = ${id} AND deleted_at IS NULL
        ${search ? db`AND (email ILIKE ${search} OR phone ILIKE ${search})` : db``}` as any;
    return reply.send({ data: users, total, users });
  });

  server.post('/:id/users', { ...auth, ...s('Create end user') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = z.object({
      email: z.string().email().toLowerCase(),
      password: z.string().min(8).max(128),
      email_confirmed: z.boolean().default(true),
      user_metadata: z.record(z.unknown()).default({}),
      app_metadata: z.record(z.unknown()).default({}),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const u = input.data;
    const [exists] = await db`SELECT 1 FROM auth.users WHERE project_id = ${id} AND lower(email) = ${u.email} AND deleted_at IS NULL`;
    if (exists) return reply.status(409).send({ error: 'Conflict', message: 'A user with this email already exists' });
    const hash = await argon2.hash(u.password, ARGON2);
    const user = await db.begin(async (sql) => {
      const [row] = await sql`
        INSERT INTO auth.users (project_id, email, email_verified, confirmed_at, raw_user_meta_data, raw_app_meta_data)
        VALUES (${id}, ${u.email}, ${u.email_confirmed}, ${u.email_confirmed ? sql`NOW()` : null},
                ${sql.json(u.user_metadata as any)}, ${sql.json({ provider: 'email', ...u.app_metadata } as any)})
        RETURNING id, email, role, email_verified, created_at`;
      await sql`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${row!['id'] as string}, ${hash})`;
      await sql`INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data)
                VALUES (${id}, ${row!['id'] as string}, 'email', ${u.email}, ${sql.json({ email: u.email })})`;
      return row!;
    });
    await audit(request, 'auth_user.created', { type: 'auth_user', id: user['id'] as string, projectId: id });
    return reply.status(201).send(user);
  });

  server.get('/:id/users/:userId', { ...auth, ...s('Get end user') }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const [user] = await db`
      SELECT id, email, phone, role, email_verified, phone_verified, is_anonymous, is_active, banned_until,
             raw_user_meta_data AS user_metadata, raw_app_meta_data AS app_metadata,
             created_at, updated_at, last_sign_in_at, confirmed_at
      FROM auth.users WHERE id = ${userId} AND project_id = ${id} AND deleted_at IS NULL`;
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const sessions = await db`
      SELECT id, ip_address, user_agent, aal, created_at, refreshed_at, not_after
      FROM auth.sessions WHERE user_id = ${userId} AND (not_after IS NULL OR not_after > NOW())
      ORDER BY created_at DESC`;
    const identities = await db`SELECT id, provider, provider_id, last_sign_in_at, created_at FROM auth.identities WHERE user_id = ${userId}`;
    const factors = await db`SELECT id, type, status, friendly_name, created_at FROM auth.mfa_factors WHERE user_id = ${userId}`;
    const events = await db`
      SELECT event_type, ip_address, timestamp, metadata FROM auth.auth_audit_log
      WHERE user_id = ${userId} ORDER BY timestamp DESC LIMIT 50`;
    return reply.send({ user, sessions, identities, factors, events });
  });

  server.patch('/:id/users/:userId', { ...auth, ...s('Update end user (ban, role, metadata)') }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    const input = z.object({
      ban_hours: z.number().int().min(0).max(24 * 365 * 100).optional(),
      role: z.string().regex(/^[a-z_]{3,50}$/).optional(),
      email_verified: z.boolean().optional(),
      app_metadata: z.record(z.unknown()).optional(),
      user_metadata: z.record(z.unknown()).optional(),
      password: z.string().min(8).max(128).optional(),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const b = input.data;
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const banned = b.ban_hours === undefined ? undefined : b.ban_hours === 0 ? null : new Date(Date.now() + b.ban_hours * 3600_000);
    const [user] = await db`
      UPDATE auth.users SET
        banned_until = ${banned === undefined ? db`banned_until` : banned},
        role = COALESCE(${b.role ?? null}, role),
        email_verified = COALESCE(${b.email_verified ?? null}, email_verified),
        raw_app_meta_data = CASE WHEN ${b.app_metadata ? db.json(b.app_metadata as any) : null}::jsonb IS NULL THEN raw_app_meta_data
                                 ELSE raw_app_meta_data || ${b.app_metadata ? db.json(b.app_metadata as any) : null}::jsonb END,
        raw_user_meta_data = CASE WHEN ${b.user_metadata ? db.json(b.user_metadata as any) : null}::jsonb IS NULL THEN raw_user_meta_data
                                  ELSE raw_user_meta_data || ${b.user_metadata ? db.json(b.user_metadata as any) : null}::jsonb END
      WHERE id = ${userId} AND project_id = ${id} AND deleted_at IS NULL
      RETURNING id, email, role, email_verified, banned_until`;
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    if (b.password) {
      const hash = await argon2.hash(b.password, ARGON2);
      await db`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${userId}, ${hash})
               ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`;
    }
    if (banned) await db`DELETE FROM auth.sessions WHERE user_id = ${userId}`;
    await audit(request, 'auth_user.updated', { type: 'auth_user', id: userId, projectId: id }, { ...b, password: b.password ? '***' : undefined });
    return reply.send(user);
  });

  server.delete('/:id/users/:userId', { ...auth, ...s('Delete end user') }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const rows = await db`DELETE FROM auth.users WHERE id = ${userId} AND project_id = ${id} RETURNING id`;
    if (!rows.length) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    await audit(request, 'auth_user.deleted', { type: 'auth_user', id: userId, projectId: id });
    return reply.send({ success: true });
  });

  server.delete('/:id/users/:userId/sessions', { ...auth, ...s('Sign a user out everywhere') }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const p = await requireProject(request, reply, id, WRITE_ROLES);
    if (!p) return;
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const rows = await db`
      DELETE FROM auth.sessions s USING auth.users u
      WHERE s.user_id = u.id AND u.id = ${userId} AND u.project_id = ${id} RETURNING s.id`;
    return reply.send({ success: true, revoked: rows.length });
  });
};
