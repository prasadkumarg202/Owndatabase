import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { projectContext } from '../middleware/auth.js';
import {
  ARGON2, audit, authSettings, clearFailedLogins, getUserByEmail, getUserByPhone, isLocked, issueSession, recordFailedLogin,
} from '../lib/session.js';
import { normalizePhone } from '../lib/sms.js';
import { refreshSession } from './refresh.js';

const passwordGrant = z.union([
  z.object({ email: z.string().email().max(255), password: z.string().min(1).max(128) }),
  z.object({ phone: z.string().max(32), password: z.string().min(1).max(128) }),
]);

const DUMMY = argon2.hash(randomBytes(12).toString('hex'), ARGON2);

export default async function (server: FastifyInstance) {
  async function passwordLogin(req: any, reply: any) {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const parsed = passwordGrant.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: 'email (or phone) and password are required' });
    const byPhone = 'phone' in parsed.data;
    // `email` is the login identifier used for lockout and audit (an E.164 number for phone logins)
    const email = byPhone ? normalizePhone((parsed.data as { phone: string }).phone) : (parsed.data as { email: string }).email.toLowerCase().trim();
    if (!email) return reply.status(400).send({ error: 'Bad Request', message: 'A valid phone number in international format is required' });
    if (byPhone && !settings.enable_phone_auth) return reply.status(403).send({ error: 'Forbidden', message: 'Phone sign-in is disabled for this project' });

    const lockedFor = await isLocked(project.id, email);
    if (lockedFor) {
      await audit(project.id, 'login_locked', req, null, null, { email });
      return reply.status(429).header('Retry-After', String(lockedFor)).send({
        error: 'Account Locked', message: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
      });
    }

    const user = byPhone ? await getUserByPhone(project.id, email) : await getUserByEmail(project.id, email);
    const [pw] = user ? await db`SELECT password_hash FROM auth.user_passwords WHERE user_id = ${user.id}` : [];
    const hash = (pw?.['password_hash'] as string | undefined) ?? (await DUMMY);
    let valid = false;
    try { valid = await argon2.verify(hash, parsed.data.password); } catch { valid = false; }

    if (!user || !pw || !valid) {
      const locked = await recordFailedLogin(project, email);
      await audit(project.id, locked ? 'login_failed_locked' : 'login_failed', req, user?.id ?? null, null, { email });
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid login credentials' });
    }
    if (user.banned_until && new Date(user.banned_until) > new Date()) {
      return reply.status(403).send({ error: 'Forbidden', message: 'User is banned' });
    }
    if (byPhone && !user.phone_verified) {
      return reply.status(403).send({ error: 'Phone Not Confirmed', message: 'Confirm your phone number before signing in' });
    }
    if (!byPhone && settings.require_email_confirmation && !user.email_verified) {
      return reply.status(403).send({ error: 'Email Not Confirmed', message: 'Confirm your email address before signing in' });
    }

    await clearFailedLogins(project.id, email);
    const session = await issueSession(project, user, req);
    await audit(project.id, 'login', req, user.id, session.session_id, { method: byPhone ? 'phone_password' : 'password' });
    return reply.send(session);
  }

  // Supabase-compatible: POST /token?grant_type=password|refresh_token
  server.post('/v1/:projectId/token', { preValidation: [projectContext] }, async (req, reply) => {
    const grant = (req.query as { grant_type?: string }).grant_type ?? (req.body as any)?.grant_type ?? 'password';
    if (grant === 'password') return passwordLogin(req, reply);
    if (grant === 'refresh_token') return refreshSession(req, reply);
    return reply.status(400).send({ error: 'Bad Request', message: `Unsupported grant_type '${grant}'` });
  });

  server.post('/v1/:projectId/login', { preValidation: [projectContext] }, passwordLogin);
}
