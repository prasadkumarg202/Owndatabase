import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/db.js';
import { userContext } from '../middleware/auth.js';
import { ARGON2, audit, authSettings, getUserByEmail, getUserById, publicUser } from '../lib/session.js';

const updateSchema = z.object({
  password: z.string().max(128).optional(),
  data: z.record(z.unknown()).optional(),
  raw_user_meta_data: z.record(z.unknown()).optional(),
  email: z.string().email().optional(),
});

export default async function (server: FastifyInstance) {
  server.get('/v1/:projectId/user', { preValidation: [userContext] }, async (req, reply) => {
    const user = await getUserById(req.ctx.project.id, req.ctx.userId!);
    if (!user) return reply.status(404).send({ error: 'Not Found', message: 'User not found' });
    const factors = await db`SELECT id, type AS factor_type, status, friendly_name, created_at FROM auth.mfa_factors WHERE user_id = ${user.id}`;
    const identities = await db`SELECT provider, provider_id, created_at, last_sign_in_at FROM auth.identities WHERE user_id = ${user.id}`;
    return reply.send({ ...publicUser(user), factors, identities, aal: req.ctx.claims?.['aal'] ?? 'aal1', user: publicUser(user) });
  });

  const update = async (req: any, reply: any) => {
    const { project, userId, claims } = req.ctx;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: parsed.error.errors[0]?.message ?? 'Invalid input' });
    const b = parsed.data;
    const settings = authSettings(project);

    // With MFA enrolled, sensitive changes need an aal2 session
    const [mfa] = await db`SELECT 1 FROM auth.mfa_factors WHERE user_id = ${userId} AND status = 'verified' LIMIT 1`;
    if (mfa && (b.password || b.email) && claims?.['aal'] !== 'aal2') {
      return reply.status(403).send({ error: 'MFA Required', message: 'Verify your second factor before changing password or email' });
    }
    if (b.password !== undefined) {
      if (b.password.length < settings.password_min_length) {
        return reply.status(422).send({ error: 'Weak Password', message: `Password must be at least ${settings.password_min_length} characters` });
      }
      const hash = await argon2.hash(b.password, ARGON2);
      await db`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${userId}, ${hash})
               ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`;
      // keep this session, end all others
      await db`DELETE FROM auth.sessions WHERE user_id = ${userId} AND id <> ${claims?.['session_id'] ?? null}`;
      await audit(project.id, 'password_changed', req, userId);
    }
    if (b.email) {
      const other = await getUserByEmail(project.id, b.email);
      if (other && other.id !== userId) return reply.status(409).send({ error: 'Conflict', message: 'Email already in use' });
      await db`UPDATE auth.users SET email = ${b.email.toLowerCase()}, email_verified = ${!settings.require_email_confirmation} WHERE id = ${userId}`;
      await db`UPDATE auth.identities SET provider_id = ${b.email.toLowerCase()} WHERE user_id = ${userId} AND provider = 'email'`;
    }
    const meta = b.data ?? b.raw_user_meta_data;
    if (meta) await db`UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || ${db.json(meta as any)} WHERE id = ${userId}`;
    const user = await getUserById(project.id, userId);
    return reply.send({ ...publicUser(user!), user: publicUser(user!) });
  };
  server.put('/v1/:projectId/user', { preValidation: [userContext] }, update);
  server.patch('/v1/:projectId/user', { preValidation: [userContext] }, update);

  server.delete('/v1/:projectId/user', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId } = req.ctx;
    await db.begin(async (sql) => {
      await sql`DELETE FROM auth.sessions WHERE user_id = ${userId!}`;
      await sql`UPDATE auth.users SET deleted_at = NOW(), email = NULL, phone = NULL,
                  raw_app_meta_data = raw_app_meta_data || '{"deleted": true}'::jsonb WHERE id = ${userId!}`;
      await sql`DELETE FROM auth.identities WHERE user_id = ${userId!}`;
      await sql`DELETE FROM auth.user_passwords WHERE user_id = ${userId!}`;
    });
    await audit(project.id, 'user_deleted', req, userId);
    return reply.send({ message: 'User deleted' });
  });
}
