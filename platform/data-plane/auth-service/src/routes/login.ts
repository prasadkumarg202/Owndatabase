import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { projectContext } from '../middleware/auth.js';
import {
  ARGON2, audit, authSettings, clearFailedLogins, getUserByEmail, isLocked, issueSession, recordFailedLogin,
} from '../lib/session.js';
import { refreshSession } from './refresh.js';

const passwordGrant = z.object({ email: z.string().email().max(255), password: z.string().min(1).max(128) });

const DUMMY = argon2.hash(randomBytes(12).toString('hex'), ARGON2);

export default async function (server: FastifyInstance) {
  async function passwordLogin(req: any, reply: any) {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const parsed = passwordGrant.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: 'email and password are required' });
    const email = parsed.data.email.toLowerCase().trim();

    const lockedFor = await isLocked(project.id, email);
    if (lockedFor) {
      await audit(project.id, 'login_locked', req, null, null, { email });
      return reply.status(429).header('Retry-After', String(lockedFor)).send({
        error: 'Account Locked', message: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
      });
    }

    const user = await getUserByEmail(project.id, email);
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
    if (settings.require_email_confirmation && !user.email_verified) {
      return reply.status(403).send({ error: 'Email Not Confirmed', message: 'Confirm your email address before signing in' });
    }

    await clearFailedLogins(project.id, email);
    const session = await issueSession(project, user, req);
    await audit(project.id, 'login', req, user.id, session.session_id, { method: 'password' });
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
