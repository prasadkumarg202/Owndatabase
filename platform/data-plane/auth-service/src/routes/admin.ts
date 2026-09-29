/**
 * Admin user management — requires a service_role API key.
 *
 *   GET    /v1/:projectId/admin/users
 *   POST   /v1/:projectId/admin/users          { email, password?, email_confirm?, user_metadata?, app_metadata? }
 *   GET    /v1/:projectId/admin/users/:userId
 *   PATCH  /v1/:projectId/admin/users/:userId  { ban_duration_hours?, user_metadata?, app_metadata?, password?, email_confirm? }
 *   DELETE /v1/:projectId/admin/users/:userId
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/db.js';
import { serviceContext } from '../middleware/auth.js';
import { ARGON2, audit, getUserByEmail, getUserById, publicUser, type UserRow, userQuotaError } from '../lib/session.js';
import { QUOTA_ERROR } from '../lib/limits.js';

const UUID = /^[0-9a-f-]{36}$/i;

export default async function (server: FastifyInstance) {
  server.get('/v1/:projectId/admin/users', { preValidation: [serviceContext] }, async (req, reply) => {
    const q = req.query as { page?: string; per_page?: string };
    const perPage = Math.min(Number(q.per_page) || 50, 1000);
    const page = Math.max(Number(q.page) || 1, 1);
    const users = await db<UserRow[]>`
      SELECT * FROM auth.users WHERE project_id = ${req.ctx.project.id} AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`;
    return reply.send({ users: users.map(publicUser), page, per_page: perPage });
  });

  server.post('/v1/:projectId/admin/users', { preValidation: [serviceContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const b = z.object({
      email: z.string().email().transform((e) => e.toLowerCase()),
      password: z.string().min(6).max(128).optional(),
      email_confirm: z.boolean().default(false),
      user_metadata: z.record(z.unknown()).default({}),
      app_metadata: z.record(z.unknown()).default({}),
    }).safeParse(req.body);
    if (!b.success) return reply.status(400).send({ error: 'Bad Request', message: b.error.errors[0]?.message ?? 'Invalid input' });
    if (await getUserByEmail(project.id, b.data.email)) return reply.status(409).send({ error: 'Conflict', message: 'User already registered' });
    const quota = await userQuotaError(project);
    if (quota) return reply.status(402).send({ error: QUOTA_ERROR, message: quota });
    const user = await db.begin(async (sql) => {
      const [u] = await sql<UserRow[]>`
        INSERT INTO auth.users (project_id, email, email_verified, confirmed_at, raw_user_meta_data, raw_app_meta_data)
        VALUES (${project.id}, ${b.data.email}, ${b.data.email_confirm}, ${b.data.email_confirm ? new Date() : null},
                ${sql.json(b.data.user_metadata as any)}, ${sql.json({ provider: 'email', ...b.data.app_metadata } as any)})
        RETURNING *`;
      await sql`INSERT INTO auth.identities (project_id, user_id, provider, provider_id) VALUES (${project.id}, ${u!.id}, 'email', ${b.data.email})`;
      if (b.data.password) {
        await sql`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${u!.id}, ${await argon2.hash(b.data.password, ARGON2)})`;
      }
      return u!;
    });
    await audit(project.id, 'admin_user_created', req, user.id);
    return reply.status(201).send(publicUser(user));
  });

  server.get('/v1/:projectId/admin/users/:userId', { preValidation: [serviceContext] }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const user = await getUserById(req.ctx.project.id, userId);
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const sessions = await db`SELECT id, ip_address, user_agent, aal, created_at, not_after FROM auth.sessions WHERE user_id = ${userId}`;
    return reply.send({ user: publicUser(user), sessions });
  });

  server.patch('/v1/:projectId/admin/users/:userId', { preValidation: [serviceContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const { userId } = req.params as { userId: string };
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const b = z.object({
      ban_duration_hours: z.number().int().min(0).optional(),
      user_metadata: z.record(z.unknown()).optional(),
      app_metadata: z.record(z.unknown()).optional(),
      password: z.string().min(6).max(128).optional(),
      email_confirm: z.boolean().optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.status(400).send({ error: 'Bad Request', message: b.error.errors[0]?.message ?? 'Invalid input' });
    const user = await getUserById(project.id, userId);
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const d = b.data;
    if (d.ban_duration_hours !== undefined) {
      const until = d.ban_duration_hours === 0 ? null : new Date(Date.now() + d.ban_duration_hours * 3600_000);
      await db`UPDATE auth.users SET banned_until = ${until} WHERE id = ${userId}`;
      if (until) await db`DELETE FROM auth.sessions WHERE user_id = ${userId}`;
    }
    if (d.user_metadata) await db`UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || ${db.json(d.user_metadata as any)} WHERE id = ${userId}`;
    if (d.app_metadata) await db`UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || ${db.json(d.app_metadata as any)} WHERE id = ${userId}`;
    if (d.email_confirm !== undefined) await db`UPDATE auth.users SET email_verified = ${d.email_confirm}, confirmed_at = CASE WHEN ${d.email_confirm} THEN COALESCE(confirmed_at, NOW()) ELSE NULL END WHERE id = ${userId}`;
    if (d.password) {
      await db`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${userId}, ${await argon2.hash(d.password, ARGON2)})
               ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`;
    }
    await audit(project.id, 'admin_user_updated', req, userId);
    return reply.send(publicUser((await getUserById(project.id, userId))!));
  });

  server.delete('/v1/:projectId/admin/users/:userId', { preValidation: [serviceContext] }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (!UUID.test(userId)) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const rows = await db`DELETE FROM auth.users WHERE id = ${userId} AND project_id = ${req.ctx.project.id} RETURNING id`;
    if (!rows.length) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    await audit(req.ctx.project.id, 'admin_user_deleted', req, userId);
    return reply.send({ message: 'User deleted' });
  });
}
