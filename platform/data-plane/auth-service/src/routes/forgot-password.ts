import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendPasswordResetEmail } from '../lib/email.js';
import { authPublicUrl, config } from '../config.js';
import { projectContext } from '../middleware/auth.js';
import { allow, audit, authSettings, getUserByEmail, isAllowedRedirect } from '../lib/session.js';
import { createOtp, publicApiKey } from './verify.js';
import { captchaBlocked } from '../lib/captcha.js';

const schema = z.object({ email: z.string().email().transform((e) => e.toLowerCase().trim()), redirect_to: z.string().optional() });

export default async function (server: FastifyInstance) {
  const handler = async (req: any, reply: any) => {
    const { project } = req.ctx;
    if (await captchaBlocked(req, reply, authSettings(project).captcha)) return reply;
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Bad Request', message: 'A valid email is required' });
    const { email } = parsed.data;
    if (!(await allow(`recover:${project.id}:${email}`, 5, 900))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many reset requests. Wait a few minutes.' });
    }
    const user = await getUserByEmail(project.id, email);
    if (user) {
      const settings = authSettings(project);
      const redirect = isAllowedRedirect(settings, parsed.data.redirect_to) ? parsed.data.redirect_to! : (settings.site_url || config.SITE_URL);
      const { code, linkToken } = await createOtp(project, user, 'password_reset', 30);
      const key = publicApiKey(req);
      const link = `${authPublicUrl}/v1/${project.id}/verify?type=recovery&token=${linkToken}&redirect_to=${encodeURIComponent(redirect)}${key ? `&apikey=${key}` : ''}`;
      await sendPasswordResetEmail(project.id, email, code, link);
      await audit(project.id, 'recovery_requested', req, user.id);
    }
    // Always the same answer, so the endpoint cannot be used to discover accounts
    return reply.send({ message: 'If an account exists, a password reset email has been sent.' });
  };
  server.post('/v1/:projectId/recover', { preValidation: [projectContext] }, handler);
  server.post('/v1/:projectId/forgot-password', { preValidation: [projectContext] }, handler);
}
