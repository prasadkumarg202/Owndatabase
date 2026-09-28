import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { db } from '../lib/db.js';
import { generateLinkToken, generateOTP, hashOTP } from '../lib/otp.js';
import { sendVerificationEmail } from '../lib/email.js';
import { config, authPublicUrl } from '../config.js';
import { projectContext } from '../middleware/auth.js';
import { allow, ARGON2, audit, authSettings, getUserByEmail, issueSession, publicUser, type UserRow } from '../lib/session.js';

const signupSchema = z.object({
  email: z.string().email().max(255).transform((e) => e.toLowerCase().trim()),
  password: z.string().max(128),
  data: z.record(z.unknown()).optional(),
  options: z.object({ data: z.record(z.unknown()).optional(), email_redirect_to: z.string().optional() }).optional(),
});

export default async function (server: FastifyInstance) {
  server.post('/v1/:projectId/signup', { preValidation: [projectContext] }, async (req, reply) => {
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
