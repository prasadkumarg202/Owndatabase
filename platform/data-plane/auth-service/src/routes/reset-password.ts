import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/db.js';
import { hashOTP } from '../lib/otp.js';
import { projectContext } from '../middleware/auth.js';
import { ARGON2, audit, authSettings, clearFailedLogins } from '../lib/session.js';

const schema = z.object({
  email: z.string().email().optional(),
  token: z.string().min(6).max(200),
  new_password: z.string().max(128),
});

/** One-step reset: code (with email) or link token + new password. Revokes every session. */
export default async function (server: FastifyInstance) {
  server.post('/v1/:projectId/reset-password', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: 'token and new_password are required' });
    const { email, token, new_password } = parsed.data;
    if (new_password.length < settings.password_min_length) {
      return reply.status(422).send({ error: 'Weak Password', message: `Password must be at least ${settings.password_min_length} characters` });
    }

    const isCode = /^\d{6}$/.test(token);
    if (isCode && !email) return reply.status(400).send({ error: 'Bad Request', message: 'email is required with a 6-digit code' });
    const [rec] = isCode
      ? await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND type = 'password_reset' AND lower(email) = lower(${email!}) AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`
      : await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND type = 'password_reset' AND token_hash = ${hashOTP(token)} AND used_at IS NULL LIMIT 1`;

    if (!rec || new Date(rec['expires_at'] as string) < new Date() || (rec['attempts'] as number) >= (rec['max_attempts'] as number)) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid or expired token' });
    }
    if (isCode && rec['otp_hash'] !== hashOTP(token)) {
      await db`UPDATE auth.otp_codes SET attempts = attempts + 1 WHERE id = ${rec['id'] as string}`;
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid or expired token' });
    }

    const passwordHash = await argon2.hash(new_password, ARGON2);
    await db.begin(async (sql) => {
      await sql`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${rec['user_id'] as string}, ${passwordHash})
                ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`;
      await sql`UPDATE auth.otp_codes SET used_at = NOW() WHERE id = ${rec['id'] as string}`;
      await sql`DELETE FROM auth.sessions WHERE user_id = ${rec['user_id'] as string}`;
    });
    if (rec['email']) await clearFailedLogins(project.id, rec['email'] as string);
    await audit(project.id, 'password_reset', req, rec['user_id'] as string);
    return reply.send({ message: 'Password updated. All sessions were signed out.' });
  });
}
