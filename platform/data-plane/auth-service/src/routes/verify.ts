/**
 * Email verification, magic links and one-time codes.
 *
 *   POST /v1/:projectId/otp      { email, create_user? }         — send a sign-in code / magic link
 *   POST /v1/:projectId/otp      { phone, create_user? }         — send a sign-in code by SMS
 *   POST /v1/:projectId/verify   { type, email, token }           — verify a 6-digit code
 *   POST /v1/:projectId/verify   { type: sms|phone_change, phone, token } — verify an SMS code
 *   GET  /v1/:projectId/verify?type=&token=&redirect_to=&apikey=  — verify a link token (redirects)
 *   POST /v1/:projectId/resend   { type: 'signup', email }        — resend confirmation
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { generateLinkToken, generateOTP, hashOTP } from '../lib/otp.js';
import { sendMagicLinkEmail, sendVerificationEmail } from '../lib/email.js';
import { normalizePhone, sendSmsCode, smsAvailable, SmsNotConfigured, testOtpFor } from '../lib/sms.js';
import { captchaBlocked } from '../lib/captcha.js';
import { authPublicUrl, config } from '../config.js';
import { projectContext } from '../middleware/auth.js';
import { allow, audit, authSettings, getUserByEmail, getUserById, getUserByPhone, isAllowedRedirect, issueSession, type UserRow, userQuotaError } from '../lib/session.js';
import { QUOTA_ERROR } from '../lib/limits.js';
import type { ProjectInfo } from '../lib/platform-auth.js';

type OtpType = 'email_verify' | 'magic_link' | 'password_reset' | 'phone_login' | 'phone_verify';

const TYPE_MAP: Record<string, OtpType> = {
  signup: 'email_verify', email: 'email_verify', email_change: 'email_verify',
  magiclink: 'magic_link', recovery: 'password_reset',
  sms: 'phone_login', phone_change: 'phone_verify',
};

type VerifyResult = { ok: true; user: UserRow; type: string } | { ok: false; status: number; message: string };

async function consume(project: ProjectInfo, type: string, match: { email?: string; phone?: string; code?: string; linkToken?: string }): Promise<VerifyResult> {
  const otpType = TYPE_MAP[type];
  if (!otpType) return { ok: false, status: 400, message: `Unknown verification type '${type}'` };
  // supabase-js verifies emailed sign-in codes with type 'email'; POST /otp stores them as magic_link
  const altType: OtpType = type === 'email' ? 'magic_link' : otpType;

  const [rec] = match.linkToken
    ? await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND (type = ${otpType} OR type = ${altType}) AND token_hash = ${hashOTP(match.linkToken)} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`
    : match.phone
      ? await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND (type = ${otpType} OR type = ${altType}) AND phone = ${match.phone} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`
      : await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND (type = ${otpType} OR type = ${altType}) AND lower(email) = lower(${match.email ?? ''}) AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`;

  if (!rec) return { ok: false, status: 400, message: 'Invalid or expired token' };
  if (new Date(rec['expires_at'] as string) < new Date()) return { ok: false, status: 400, message: 'Token has expired' };
  if ((rec['attempts'] as number) >= (rec['max_attempts'] as number)) return { ok: false, status: 429, message: 'Too many attempts. Request a new code.' };
  if (match.code !== undefined && rec['otp_hash'] !== hashOTP(match.code)) {
    await db`UPDATE auth.otp_codes SET attempts = attempts + 1 WHERE id = ${rec['id'] as string}`;
    return { ok: false, status: 400, message: 'Invalid or expired token' };
  }

  const user = await getUserById(project.id, rec['user_id'] as string);
  if (!user) return { ok: false, status: 400, message: 'User no longer exists' };
  const isPhone = otpType === 'phone_login' || otpType === 'phone_verify';
  const phone = rec['phone'] as string | null;
  if (otpType === 'phone_verify' && phone) {
    const other = await getUserByPhone(project.id, phone);
    if (other && other.id !== user.id) return { ok: false, status: 409, message: 'Phone number already in use' };
  }
  await db.begin(async (sql) => {
    await sql`UPDATE auth.otp_codes SET used_at = NOW() WHERE id = ${rec['id'] as string}`;
    if (otpType === 'email_verify' || otpType === 'magic_link') {
      await sql`UPDATE auth.users SET email_verified = true, confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = ${user.id}`;
      await convertAnonymous(sql, user.id, 'email', user.email);
    }
    if (isPhone) {
      await sql`UPDATE auth.users SET phone = ${phone}, phone_verified = true, confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = ${user.id}`;
      await convertAnonymous(sql, user.id, 'phone', null);
      const [ident] = await sql`SELECT id FROM auth.identities WHERE user_id = ${user.id} AND provider = 'phone'`;
      if (ident) {
        await sql`UPDATE auth.identities SET provider_id = ${phone}, identity_data = ${sql.json({ phone, sub: user.id })} WHERE id = ${ident['id'] as string}`;
      } else {
        await sql`INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data)
                  VALUES (${project.id}, ${user.id}, 'phone', ${phone}, ${sql.json({ phone, sub: user.id })})`;
      }
    }
  });
  if (isPhone) { user.phone = phone; user.phone_verified = true; } else user.email_verified = true;
  return { ok: true, user, type };
}

export async function createOtp(project: ProjectInfo, user: UserRow, type: OtpType, minutes: number, phone: string | null = null, fixedCode: string | null = null) {
  const code = fixedCode ?? generateOTP();
  // SMS codes have no link form
  const linkToken = phone ? null : generateLinkToken();
  // Only the newest code of a kind stays valid
  await db`UPDATE auth.otp_codes SET used_at = NOW() WHERE user_id = ${user.id} AND type = ${type} AND used_at IS NULL`;
  await db`INSERT INTO auth.otp_codes (project_id, user_id, email, phone, type, otp_hash, token_hash, expires_at)
           VALUES (${project.id}, ${user.id}, ${phone ? null : user.email}, ${phone}, ${type}, ${hashOTP(code)},
                   ${linkToken ? hashOTP(linkToken) : null}, NOW() + make_interval(mins => ${minutes}))`;
  return { code, linkToken: linkToken ?? '' };
}

type ErrorBody = { status: number; error: string; message: string };

/**
 * Sends an SMS code to `phone` for `user`. Rate limited per number and per
 * client IP (SMS pumping / toll fraud). Returns an error body, or null.
 */
export async function sendPhoneOtp(req: FastifyRequest, project: ProjectInfo, user: UserRow, phone: string, type: 'phone_login' | 'phone_verify'): Promise<ErrorBody | null> {
  const settings = authSettings(project);
  if (!(await allow(`sms:${project.id}:${phone}`, 5, 3600)) || !(await allow(`sms-ip:${project.id}:${req.ip}`, 20, 3600))) {
    return { status: 429, error: 'Too Many Requests', message: 'Too many codes requested. Wait before trying again.' };
  }
  const minutes = Number(settings.sms_otp_expiry_minutes) || config.SMS_OTP_EXPIRY_MINUTES || 10;
  // test numbers: the fixed code, no SMS (for app-store review, CI, development)
  const testCode = testOtpFor(settings.sms ?? {}, phone);
  const { code } = await createOtp(project, user, type, minutes, phone, testCode);
  if (testCode) {
    await audit(project.id, 'sms_otp_test_number', req, user.id);
    return null;
  }
  try {
    await sendSmsCode(project.id, settings.sms ?? {}, phone, code);
  } catch (err) {
    req.log.error({ err, projectId: project.id }, 'SMS delivery failed');
    await db`UPDATE auth.otp_codes SET used_at = NOW() WHERE user_id = ${user.id} AND type = ${type} AND used_at IS NULL`;
    return err instanceof SmsNotConfigured
      ? { status: 501, error: 'Not Implemented', message: err.message }
      : { status: 502, error: 'Bad Gateway', message: 'Could not send the SMS. Try again later.' };
  }
  await audit(project.id, type === 'phone_login' ? 'sms_otp_sent' : 'phone_change_sent', req, user.id);
  return null;
}

/** Phone auth must be switched on and able to deliver. Returns an error body, or null. */
export function phoneAuthError(project: ProjectInfo): ErrorBody | null {
  const settings = authSettings(project);
  if (!settings.enable_phone_auth) return { status: 403, error: 'Forbidden', message: 'Phone sign-in is disabled for this project' };
  if (!smsAvailable(settings.sms ?? {}) && !(settings.sms?.test_otp || config.SMS_TEST_OTP)) return { status: 501, error: 'Not Implemented', message: 'No SMS provider is configured for this project' };
  return null;
}

const SENT = { message: 'If the number can sign in, a code has been sent.' };

async function phoneOtp(req: FastifyRequest, reply: FastifyReply) {
  const { project } = req.ctx;
  const settings = authSettings(project);
  const body = z.object({
    phone: z.string().max(32),
    create_user: z.boolean().default(true),
    data: z.record(z.unknown()).optional(),
    options: z.object({ data: z.record(z.unknown()).optional(), should_create_user: z.boolean().optional() }).optional(),
  }).safeParse(req.body);
  const phone = body.success ? normalizePhone(body.data.phone) : null;
  if (!body.success || !phone) {
    return reply.status(400).send({ error: 'Bad Request', message: 'A valid phone number in international format is required, e.g. +919876543210' });
  }
  const blocked = phoneAuthError(project);
  if (blocked) return reply.status(blocked.status).send({ error: blocked.error, message: blocked.message });

  let user = await getUserByPhone(project.id, phone);
  if (!user) {
    // Same response either way: do not reveal which numbers exist
    if (!(body.data.options?.should_create_user ?? body.data.create_user) || !settings.enable_signup) return reply.send(SENT);
    const quota = await userQuotaError(project);
    if (quota) return reply.status(402).send({ error: QUOTA_ERROR, message: quota });
    const meta = body.data.data ?? body.data.options?.data ?? {};
    const [u] = await db<UserRow[]>`
      INSERT INTO auth.users (project_id, phone, raw_user_meta_data, raw_app_meta_data)
      VALUES (${project.id}, ${phone}, ${db.json(meta as any)}, ${db.json({ provider: 'phone', providers: ['phone'] })})
      RETURNING *`;
    user = u!;
  }
  if (user.banned_until && new Date(user.banned_until) > new Date()) return reply.send(SENT);
  const failed = await sendPhoneOtp(req, project, user, phone, 'phone_login');
  if (failed) return reply.status(failed.status).send({ error: failed.error, message: failed.message });
  return reply.send(SENT);
}

function linkFor(project: ProjectInfo, type: string, token: string, redirectTo: string, apikey: string | null) {
  return `${authPublicUrl}/v1/${project.id}/verify?type=${type}&token=${token}&redirect_to=${encodeURIComponent(redirectTo)}${apikey ? `&apikey=${encodeURIComponent(apikey)}` : ''}`;
}

export function publicApiKey(req: FastifyRequest): string | null {
  // Links only ever embed anon keys, never service keys
  const k = (req.headers['apikey'] ?? req.headers['x-api-key']) as string | undefined;
  return k?.startsWith('odb_anon_') ? k : null;
}

export default async function (server: FastifyInstance) {
  server.post('/v1/:projectId/otp', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const settings = authSettings(project);
    if (await captchaBlocked(req, reply, settings.captcha)) return reply;
    if ((req.body as any)?.phone !== undefined) return phoneOtp(req, reply);
    const body = z.object({
      email: z.string().email().transform((e) => e.toLowerCase().trim()),
      create_user: z.boolean().default(true),
      redirect_to: z.string().optional(),
      data: z.record(z.unknown()).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'A valid email or phone is required' });
    if (!settings.enable_magic_link) return reply.status(403).send({ error: 'Forbidden', message: 'Magic links are disabled for this project' });
    if (!(await allow(`otp:${project.id}:${body.data.email}`, 5, 900))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many codes requested. Wait a few minutes.' });
    }

    let user = await getUserByEmail(project.id, body.data.email);
    if (!user) {
      if (!body.data.create_user || !settings.enable_signup) {
        // Same response either way: do not reveal which emails exist
        return reply.send({ message: 'If the address can sign in, a code has been sent.' });
      }
      const quota = await userQuotaError(project);
      if (quota) return reply.status(402).send({ error: QUOTA_ERROR, message: quota });
      const [u] = await db<UserRow[]>`
        INSERT INTO auth.users (project_id, email, raw_user_meta_data, raw_app_meta_data)
        VALUES (${project.id}, ${body.data.email}, ${db.json((body.data.data ?? {}) as any)}, ${db.json({ provider: 'email', providers: ['email'] })})
        RETURNING *`;
      await db`INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data)
               VALUES (${project.id}, ${u!.id}, 'email', ${body.data.email}, ${db.json({ email: body.data.email })})`;
      user = u!;
    }
    const redirect = isAllowedRedirect(settings, body.data.redirect_to) ? body.data.redirect_to! : (settings.site_url || config.SITE_URL);
    const { code, linkToken } = await createOtp(project, user, 'magic_link', 60);
    await sendMagicLinkEmail(project.id, body.data.email, code, linkFor(project, 'magiclink', linkToken, redirect, publicApiKey(req)));
    await audit(project.id, 'magiclink_sent', req, user.id);
    return reply.send({ message: 'If the address can sign in, a code has been sent.' });
  });

  server.post('/v1/:projectId/resend', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const body = z.object({ email: z.string().email(), type: z.enum(['signup']).default('signup') }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'A valid email is required' });
    if (!(await allow(`resend:${project.id}:${body.data.email.toLowerCase()}`, 3, 900))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Please wait before requesting another email.' });
    }
    const user = await getUserByEmail(project.id, body.data.email);
    if (user && !user.email_verified) {
      const { code, linkToken } = await createOtp(project, user, 'email_verify', 24 * 60);
      const settings = authSettings(project);
      await sendVerificationEmail(project.id, user.email!, code, linkFor(project, 'signup', linkToken, settings.site_url || config.SITE_URL, publicApiKey(req)));
    }
    return reply.send({ message: 'If the account needs confirmation, a new email has been sent.' });
  });

  server.post('/v1/:projectId/verify', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const body = z.object({
      type: z.string().default('signup'),
      email: z.string().email().optional(),
      phone: z.string().max(32).optional(),
      token: z.string().min(4).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'type, email and token are required' });

    const isCode = /^\d{6}$/.test(body.data.token);
    let res: VerifyResult;
    if (body.data.type === 'sms' || body.data.type === 'phone_change') {
      const phone = body.data.phone ? normalizePhone(body.data.phone) : null;
      if (!phone || !isCode) return reply.status(400).send({ error: 'Bad Request', message: 'phone and a 6-digit token are required' });
      res = await consume(project, body.data.type, { phone, code: body.data.token });
    } else {
      if (isCode && !body.data.email) return reply.status(400).send({ error: 'Bad Request', message: 'email is required with a 6-digit code' });
      res = await consume(project, body.data.type, isCode ? { email: body.data.email!, code: body.data.token } : { linkToken: body.data.token });
    }
    if (!res.ok) return reply.status(res.status).send({ error: 'Verification Failed', message: res.message });

    if (res.user.banned_until && new Date(res.user.banned_until) > new Date()) {
      return reply.status(403).send({ error: 'Forbidden', message: 'User is banned' });
    }
    const session = await issueSession(project, res.user, req, { amr: res.type === 'recovery' ? 'recovery' : res.type === 'sms' ? 'sms' : 'otp' });
    await audit(project.id, `verify_${res.type}`, req, res.user.id, session.session_id);
    return reply.send(session);
  });

  // Link flow: the email link opens this URL in the browser.
  server.get('/v1/:projectId/verify', { preValidation: [projectContext] }, async (req, reply) => {
    const { project } = req.ctx;
    const settings = authSettings(project);
    const q = req.query as { type?: string; token?: string; redirect_to?: string };
    const redirect = isAllowedRedirect(settings, q.redirect_to) ? q.redirect_to! : (settings.site_url || config.SITE_URL);
    const res = await consume(project, q.type ?? 'signup', { linkToken: q.token ?? '' });
    if (!res.ok) return reply.redirect(`${redirect}#error=verification_failed&error_description=${encodeURIComponent(res.message)}`);
    const s = await issueSession(project, res.user, req, { amr: 'otp' });
    await audit(project.id, `verify_${res.type}`, req, res.user.id, s.session_id, { via: 'link' });
    const frag = new URLSearchParams({
      access_token: s.access_token, refresh_token: s.refresh_token, expires_in: String(s.expires_in), token_type: 'bearer', type: res.type,
    });
    return reply.redirect(`${redirect}#${frag.toString()}`);
  });
}

/**
 * An anonymous user who confirmed an email address or phone number becomes a permanent user
 * (docs/anonymous-auth.md): is_anonymous = false, the provider joins app_metadata.providers and an
 * email identity is added.
 */
export async function convertAnonymous(sql: any, userId: string, provider: 'email' | 'phone', email: string | null) {
  const [u] = await sql`
    UPDATE auth.users SET is_anonymous = false,
      raw_app_meta_data = raw_app_meta_data || jsonb_build_object('provider', ${provider}::text,
        'providers', (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements_text(COALESCE(raw_app_meta_data->'providers', '[]'::jsonb) || to_jsonb(${provider}::text)) p WHERE p <> 'anonymous'))
    WHERE id = ${userId} AND is_anonymous RETURNING project_id, email`;
  if (u && provider === 'email' && (email ?? u.email)) {
    const e = String(email ?? u.email).toLowerCase();
    await sql`INSERT INTO auth.identities (project_id, user_id, provider, provider_id, identity_data)
              VALUES (${u.project_id}, ${userId}, 'email', ${e}, ${sql.json({ email: e, sub: userId })})
              ON CONFLICT (project_id, provider, provider_id) DO NOTHING`;
  }
}
