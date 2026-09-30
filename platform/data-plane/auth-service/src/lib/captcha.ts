/**
 * Bot protection: CAPTCHA on sign-up, password sign-in, OTP / magic link and
 * password recovery (project Auth settings → captcha).
 *
 *   captcha: { enabled, provider: 'turnstile' | 'hcaptcha', secret }
 *
 * The client sends the widget's token as `captcha_token` or, like supabase-js,
 * `gotrue_meta_security: { captcha_token }`. Refresh-token calls are exempt.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authSecret } from './vault.js';

export interface CaptchaSettings { enabled?: boolean; provider?: 'turnstile' | 'hcaptcha'; secret?: string }

const VERIFY_URL = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
} as const;

export function captchaToken(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, any>;
  const t = b['captcha_token'] ?? b['gotrue_meta_security']?.['captcha_token'] ?? b['options']?.['captchaToken'];
  return typeof t === 'string' && t.length > 0 && t.length < 4096 ? t : null;
}

/** null when the request may proceed, else an error body. */
export async function checkCaptcha(req: FastifyRequest, settings: CaptchaSettings | undefined): Promise<{ status: number; error: string; message: string } | null> {
  if (!settings?.enabled) return null;
  const provider = settings.provider === 'hcaptcha' ? 'hcaptcha' : 'turnstile';
  const token = captchaToken(req.body);
  if (!token) return { status: 400, error: 'Captcha Required', message: 'Complete the CAPTCHA (send captcha_token)' };
  const projectId = (req as any).ctx?.project?.id as string | undefined;
  const secret = projectId ? await authSecret(projectId, 'auth.captcha.secret', settings.secret) : settings.secret;
  if (!secret) {
    req.log.error({ provider }, 'CAPTCHA enabled without a secret');
    return { status: 500, error: 'Captcha Misconfigured', message: 'CAPTCHA is enabled but not configured' };
  }
  try {
    const res = await fetch(VERIFY_URL[provider], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: req.ip }),
      signal: AbortSignal.timeout(8000),
    });
    const r = await res.json() as { success?: boolean; 'error-codes'?: string[] };
    if (r.success) return null;
    req.log.info({ provider, codes: r['error-codes'] }, 'CAPTCHA rejected');
    return { status: 400, error: 'Captcha Failed', message: 'CAPTCHA verification failed. Try again.' };
  } catch (err) {
    // fail closed: a bot wave could otherwise wait for the provider to time out
    req.log.warn({ err: (err as Error).message, provider }, 'CAPTCHA provider unreachable');
    return { status: 503, error: 'Captcha Unavailable', message: 'Could not verify the CAPTCHA right now. Try again.' };
  }
}

/**
 * Route guard: true when the request was answered (blocked). Calls with a
 * service_role key come from the project's own servers and are exempt.
 */
export async function captchaBlocked(req: FastifyRequest, reply: FastifyReply, settings: CaptchaSettings | undefined): Promise<boolean> {
  if ((req as any).ctx?.role === 'service_role') return false;
  const blocked = await checkCaptcha(req, settings);
  if (!blocked) return false;
  await reply.status(blocked.status).send({ error: blocked.error, message: blocked.message });
  return true;
}
