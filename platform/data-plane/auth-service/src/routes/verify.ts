/**
 * Email verification, magic links and one-time codes.
 *
 *   POST /v1/:projectId/otp      { email, create_user? }         — send a sign-in code / magic link
 *   POST /v1/:projectId/verify   { type, email, token }           — verify a 6-digit code
 *   GET  /v1/:projectId/verify?type=&token=&redirect_to=&apikey=  — verify a link token (redirects)
 *   POST /v1/:projectId/resend   { type: 'signup', email }        — resend confirmation
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { generateLinkToken, generateOTP, hashOTP } from '../lib/otp.js';
import { sendMagicLinkEmail, sendVerificationEmail } from '../lib/email.js';
import { authPublicUrl, config } from '../config.js';
import { projectContext } from '../middleware/auth.js';
import { allow, audit, authSettings, getUserByEmail, getUserById, isAllowedRedirect, issueSession, type UserRow } from '../lib/session.js';
import type { ProjectInfo } from '../lib/platform-auth.js';

const TYPE_MAP: Record<string, 'email_verify' | 'magic_link' | 'password_reset'> = {
  signup: 'email_verify', email: 'email_verify', email_change: 'email_verify',
  magiclink: 'magic_link', recovery: 'password_reset',
};

type VerifyResult = { ok: true; user: UserRow; type: string } | { ok: false; status: number; message: string };

async function consume(project: ProjectInfo, type: string, match: { email?: string; code?: string; linkToken?: string }): Promise<VerifyResult> {
  const otpType = TYPE_MAP[type];
  if (!otpType) return { ok: false, status: 400, message: `Unknown verification type '${type}'` };

  const [rec] = match.linkToken
    ? await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND type = ${otpType} AND token_hash = ${hashOTP(match.linkToken)} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`
    : await db`SELECT * FROM auth.otp_codes WHERE project_id = ${project.id} AND type = ${otpType} AND lower(email) = lower(${match.email ?? ''}) AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`;

  if (!rec) return { ok: false, status: 400, message: 'Invalid or expired token' };
  if (new Date(rec['expires_at'] as string) < new Date()) return { ok: false, status: 400, message: 'Token has expired' };
  if ((rec['attempts'] as number) >= (rec['max_attempts'] as number)) return { ok: false, status: 429, message: 'Too many attempts. Request a new code.' };
  if (match.code !== undefined && rec['otp_hash'] !== hashOTP(match.code)) {
    await db`UPDATE auth.otp_codes SET attempts = attempts + 1 WHERE id = ${rec['id'] as string}`;
    return { ok: false, status: 400, message: 'Invalid or expired token' };
  }

  const user = await getUserById(project.id, rec['user_id'] as string);
  if (!user) return { ok: false, status: 400, message: 'User no longer exists' };
  await db.begin(async (sql) => {
    await sql`UPDATE auth.otp_codes SET used_at = NOW() WHERE id = ${rec['id'] as string}`;
    if (otpType === 'email_verify' || otpType === 'magic_link') {
      await sql`UPDATE auth.users SET email_verified = true, confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = ${user.id}`;
    }
  });
  user.email_verified = true;
  return { ok: true, user, type };
}

export async function createOtp(project: ProjectInfo, user: UserRow, type: 'email_verify' | 'magic_link' | 'password_reset', minutes: number) {
  const code = generateOTP();
  const linkToken = generateLinkToken();
  // Only the newest code of a kind stays valid
  await db`UPDATE auth.otp_codes SET used_at = NOW() WHERE user_id = ${user.id} AND type = ${type} AND used_at IS NULL`;
  await db`INSERT INTO auth.otp_codes (project_id, user_id, email, type, otp_hash, token_hash, expires_at)
           VALUES (${project.id}, ${user.id}, ${user.email}, ${type}, ${hashOTP(code)}, ${hashOTP(linkToken)},
                   NOW() + make_interval(mins => ${minutes}))`;
  return { code, linkToken };
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
    const body = z.object({
      email: z.string().email().transform((e) => e.toLowerCase().trim()),
      create_user: z.boolean().default(true),
      redirect_to: z.string().optional(),
      data: z.record(z.unknown()).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'A valid email is required' });
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
      token: z.string().min(4).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'type, email and token are required' });

    const isCode = /^\d{6}$/.test(body.data.token);
    if (isCode && !body.data.email) return reply.status(400).send({ error: 'Bad Request', message: 'email is required with a 6-digit code' });
    const res = await consume(project, body.data.type, isCode ? { email: body.data.email!, code: body.data.token } : { linkToken: body.data.token });
    if (!res.ok) return reply.status(res.status).send({ error: 'Verification Failed', message: res.message });

    const session = await issueSession(project, res.user, req, { amr: res.type === 'recovery' ? 'recovery' : 'otp' });
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
