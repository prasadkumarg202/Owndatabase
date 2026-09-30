import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/db.js';
import { generateLinkToken, generateOTP, hashOTP } from '../lib/otp.js';
import { sendVerificationEmail } from '../lib/email.js';
import { config, authPublicUrl } from '../config.js';
import { projectContext } from '../middleware/auth.js';
import { allow, ARGON2, audit, authSettings, getUserByEmail, getUserByPhone, issueSession, publicUser, type UserRow, userQuotaError } from '../lib/session.js';
import { QUOTA_ERROR } from '../lib/limits.js';
import { normalizePhone } from '../lib/sms.js';
import { phoneAuthError, sendPhoneOtp } from './verify.js';
import { captchaBlocked } from '../lib/captcha.js';

const signupSchema = z.object({
  email: z.string().email().max(255).transform((e) => e.toLowerCase().trim()),
  password: z.string().max(128),
  data: z.record(z.unknown()).optional(),
  options: z.object({ data: z.record(z.unknown()).optional(), email_redirect_to: z.string().optional() }).optional(),
});

const phoneSignupSchema = z.object({
  phone: z.string().max(32),
  password: z.string().max(128),
  data: z.record(z.unknown()).optional(),
  options: z.object({ data: z.record(z.unknown()).optional() }).optional(),
});

export default async function (server: FastifyInstance) {
  // Phone + password: the account is confirmed with an SMS code (POST /verify type=sms)
  async function phoneSignup(req: any, reply: any) {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const parsed = phoneSignupSchema.safeParse(req.body);
    const phone = parsed.success ? normalizePhone(parsed.data.phone) : null;
    if (!parsed.success || !phone) {
      return reply.status(400).send({ error: 'Bad Request', message: 'A valid phone number in international format is required, e.g. +919876543210' });
    }
    const blocked = phoneAuthError(project);
    if (blocked) return reply.status(blocked.status).send({ error: blocked.error, message: blocked.message });
    if (!settings.enable_signup && req.ctx.role !== 'service_role') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Signups are disabled for this project' });
    }
    if (parsed.data.password.length < settings.password_min_length) {
      return reply.status(422).send({ error: 'Weak Password', message: `Password must be at least ${settings.password_min_length} characters` });
    }
    if (!(await allow(`signup:${project.id}:${req.ip}`, 30, 3600))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many signups from this address. Try again later.' });
    }
    const existing = await getUserByPhone(project.id, phone);
    if (existing?.phone_verified) return reply.status(409).send({ error: 'Conflict', message: 'User already registered' });
    if (!existing) {
      const quota = await userQuotaError(project);
      if (quota) return reply.status(402).send({ error: QUOTA_ERROR, message: quota });
    }

    const passwordHash = await argon2.hash(parsed.data.password, ARGON2);
    const metadata = parsed.data.data ?? parsed.data.options?.data ?? {};
    // An unconfirmed number can be claimed again (the SMS code proves ownership)
    const user = await db.begin(async (sql) => {
      const [u] = existing
        ? await sql<UserRow[]>`UPDATE auth.users SET raw_user_meta_data = ${sql.json(metadata as any)} WHERE id = ${existing.id} RETURNING *`
        : await sql<UserRow[]>`
            INSERT INTO auth.users (project_id, phone, raw_user_meta_data, raw_app_meta_data)
            VALUES (${project.id}, ${phone}, ${sql.json(metadata as any)}, ${sql.json({ provider: 'phone', providers: ['phone'] })})
            RETURNING *`;
      await sql`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${u!.id}, ${passwordHash})
                ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`;
      return u!;
    });
    const failed = await sendPhoneOtp(req, project, user, phone, 'phone_login');
    if (failed) return reply.status(failed.status).send({ error: failed.error, message: failed.message });
    await audit(project.id, 'signup', req, user.id, null, { phone });
    return reply.status(200).send({ user: publicUser(user), session: null, message: 'Enter the code sent by SMS to confirm your number' });
  }

  // signInAnonymously(): a user without email / phone, until they add one (docs/anonymous-auth.md)
  async function anonymousSignup(req: any, reply: any) {
    const { project } = req.ctx;
    const settings = authSettings(project);
    if (!settings.enable_anonymous_sign_ins) {
      return reply.status(422).send({ error: 'Anonymous Sign-ins Disabled', message: 'Anonymous sign-ins are disabled for this project' });
    }
    if (!settings.enable_signup && req.ctx.role !== 'service_role') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Signups are disabled for this project' });
    }
    if (!(await allow(`anon-signup:${project.id}:${req.ip}`, Number(process.env['ANONYMOUS_SIGNUPS_PER_HOUR'] ?? 30), 3600))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many anonymous sign-ins from this address. Try again later.' });
    }
    const quota = await userQuotaError(project);
    if (quota) return reply.status(402).send({ error: QUOTA_ERROR, message: quota });
    const b = (req.body ?? {}) as { data?: Record<string, unknown>; options?: { data?: Record<string, unknown> } };
    const metadata = b.data ?? b.options?.data ?? {};
    if (typeof metadata !== 'object' || Array.isArray(metadata)) return reply.status(400).send({ error: 'Bad Request', message: 'data must be an object' });
    const [user] = await db<UserRow[]>`
      INSERT INTO auth.users (project_id, is_anonymous, raw_user_meta_data, raw_app_meta_data)
      VALUES (${project.id}, true, ${db.json(metadata as any)}, ${db.json({ provider: 'anonymous', providers: ['anonymous'] })})
      RETURNING *`;
    const session = await issueSession(project, user!, req, { amr: 'anonymous' });
    await audit(project.id, 'signup', req, user!.id, session.session_id, { anonymous: true });
    return reply.status(200).send(session);
  }

  server.post('/v1/:projectId/signup', { preValidation: [projectContext] }, async (req, reply) => {
    if (await captchaBlocked(req, reply, authSettings(req.ctx.project).captcha)) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body['email'] === undefined && body['phone'] === undefined && body['password'] === undefined) return anonymousSignup(req, reply);
    if ((req.body as any)?.phone !== undefined && (req.body as any)?.email === undefined) return phoneSignup(req, reply);
    const { project } = req.ctx;
    const settings = authSettings(project);
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: parsed.error.errors[0]?.message ?? 'Invalid input' });
    const { email, password } = parsed.data;
    const metadata = parsed.data.data ?? parsed.data.options?.data ?? {};

    if (!settings.enable_signup && req.ctx.role !== 'service_role') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Signups are disabled for this project' });
    }
    if (password.length < settings.password_min_length) {
      return reply.status(422).send({ error: 'Weak Password', message: `Password must be at least ${settings.password_min_length} characters` });
    }
    if (!(await allow(`signup:${project.id}:${req.ip}`, 30, 3600))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many signups from this address. Try again later.' });
    }
    if (await getUserByEmail(project.id, email)) {
      return reply.status(409).send({ error: 'Conflict', message: 'User already registered' });
    }
    const quota = await userQuotaError(project);
    if (quota) return reply.status(402).send({ error: QUOTA_ERROR, message: quota });

    const passwordHash = await argon2.hash(password, ARGON2);
    const confirmNow = !settings.require_email_confirmation;
    const code = generateOTP();
    const linkToken = generateLinkToken();

    const user = await db.begin(async (sql) => {
      const [u] = await sql<UserRow[]>`
        INSERT INTO auth.users (project_id, email, email_verified, confirmed_at, raw_user_meta_data, raw_app_meta_data)
        VALUES (${project.id}, ${email}, ${confirmNow}, ${confirmNow ? new Date() : null},
                ${sql.json(metadata as any)}, ${sql.json({ provider: 'email', providers: ['email'] })})
        RETURNING *`;
      await sql`INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data)
                VALUES (${project.id}, ${u!.id}, 'email', ${email}, ${sql.json({ email, sub: u!.id })})`;
      await sql`INSERT INTO auth.user_passwords (user_id, password_hash) VALUES (${u!.id}, ${passwordHash})`;
      if (!confirmNow) {
        await sql`INSERT INTO auth.otp_codes (project_id, user_id, email, type, otp_hash, token_hash, expires_at)
                  VALUES (${project.id}, ${u!.id}, ${email}, 'email_verify', ${hashOTP(code)}, ${hashOTP(linkToken)}, NOW() + INTERVAL '24 hours')`;
      }
      return u!;
    });

    await audit(project.id, 'signup', req, user.id, null, { email });

    if (!confirmNow) {
      const link = `${authPublicUrl}/v1/${project.id}/verify?type=signup&token=${linkToken}&redirect_to=${encodeURIComponent(settings.site_url || config.SITE_URL)}`;
      await sendVerificationEmail(project.id, email, code, link);
      return reply.status(200).send({ user: publicUser(user), session: null, message: 'Check your email to confirm your account' });
    }
    const session = await issueSession(project, user, req);
    return reply.status(200).send({ ...session, session: { access_token: session.access_token, refresh_token: session.refresh_token } });
  });
}
