/**
 * Multi-factor authentication (docs/mfa.md), as supabase.auth.mfa: an authenticator app (TOTP) or a code by SMS.
 *
 *   GET    /v1/:projectId/factors
 *   POST   /v1/:projectId/factors                    { factor_type: 'totp' | 'phone', phone?, friendly_name? }
 *                                                    totp → secret + otpauth URI; phone → the factor
 *   POST   /v1/:projectId/factors/:factorId/challenge → { id, type, expires_at }; phone factors get a code by SMS
 *   POST   /v1/:projectId/factors/:factorId/verify   { code, challenge_id? } → aal2 session (phone needs challenge_id)
 *   DELETE /v1/:projectId/factors/:factorId          (needs aal2)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { userContext } from '../middleware/auth.js';
import { allow, audit, authSettings, getUserById, issueSession, sha256 } from '../lib/session.js';
import { normalizePhone, sendSmsCode, smsAvailable, testOtpFor } from '../lib/sms.js';
import { config } from '../config.js';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { sealMfa, unsealMfa } from '../lib/crypto.js';

const CHALLENGE_MINUTES = 5;
const MAX_ATTEMPTS = 5;
/** The database says 'sms', the API (like Supabase) says 'phone'. */
const apiType = (t: unknown) => (t === 'sms' ? 'phone' : String(t));

export default async function (server: FastifyInstance) {
  server.get('/v1/:projectId/factors', { preValidation: [userContext] }, async (req, reply) => {
    const rows = (await db`SELECT id, type::text AS factor_type, status, friendly_name, phone, created_at, updated_at FROM auth.mfa_factors WHERE user_id = ${req.ctx.userId!} ORDER BY created_at`)
      .map((r) => ({ ...r, factor_type: apiType(r['factor_type']) }));
    return reply.send({ data: rows, all: rows, totp: rows.filter((r) => r['factor_type'] === 'totp'), phone: rows.filter((r) => r['factor_type'] === 'phone') });
  });

  server.post('/v1/:projectId/factors', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId, claims } = req.ctx;
    if (!authSettings(project).enable_mfa) return reply.status(403).send({ error: 'Forbidden', message: 'MFA is disabled for this project' });
    const body = z.object({
      factor_type: z.enum(['totp', 'phone']).default('totp'), friendly_name: z.string().max(100).optional(),
      issuer: z.string().max(100).optional(), phone: z.string().max(32).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'factor_type must be totp or phone' });
    const settings = authSettings(project);
    let phone: string | null = null;
    if (body.data.factor_type === 'phone') {
      if (!settings.enable_mfa_phone) return reply.status(403).send({ error: 'Forbidden', message: 'SMS as a second factor is disabled for this project' });
      if (!smsAvailable(settings.sms ?? {}) && !(settings.sms?.test_otp || config.SMS_TEST_OTP)) {
        return reply.status(501).send({ error: 'Not Implemented', message: 'No SMS provider is configured for this project' });
      }
      phone = body.data.phone ? normalizePhone(body.data.phone) : null;
      if (!phone) return reply.status(400).send({ error: 'Bad Request', message: 'A valid phone number in international format is required, e.g. +919876543210' });
    }

    const [{ verified }] = await db`SELECT count(*)::int AS verified FROM auth.mfa_factors WHERE user_id = ${userId!} AND status = 'verified'` as any;
    if (verified > 0 && claims?.['aal'] !== 'aal2') {
      return reply.status(403).send({ error: 'MFA Required', message: 'Verify an existing factor before adding another' });
    }
    // Drop abandoned enrolments
    await db`DELETE FROM auth.mfa_factors WHERE user_id = ${userId!} AND status = 'unverified'`;

    if (phone) {
      const [factor] = await db`
        INSERT INTO auth.mfa_factors (user_id, type, status, friendly_name, phone)
        VALUES (${userId!}, 'sms', 'unverified', ${body.data.friendly_name ?? 'SMS'}, ${phone})
        RETURNING id, status, friendly_name, phone`;
      await audit(project.id, 'mfa_enroll_started', req, userId, null, { type: 'phone' });
      return reply.status(201).send({ ...factor, type: 'phone', factor_type: 'phone' });
    }
    const secret = generateTotpSecret();
    const user = await getUserById(project.id, userId!);
    const [factor] = await db`
      INSERT INTO auth.mfa_factors (user_id, type, status, friendly_name, secret)
      VALUES (${userId!}, 'totp', 'unverified', ${body.data.friendly_name ?? 'Authenticator app'}, ${await sealMfa(project.id, userId!, secret)})
      RETURNING id, type AS factor_type, status, friendly_name`;
    const uri = otpauthUri(secret, user?.email ?? userId!, body.data.issuer ?? project.slug);
    await audit(project.id, 'mfa_enroll_started', req, userId);
    return reply.status(201).send({ ...factor, id: factor!['id'], type: 'totp', totp: { secret, uri } });
  });

  server.post('/v1/:projectId/factors/:factorId/challenge', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId } = req.ctx;
    const { factorId } = req.params as { factorId: string };
    if (!/^[0-9a-f-]{36}$/i.test(factorId)) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });
    const [factor] = await db`SELECT id, type::text AS type, phone FROM auth.mfa_factors WHERE id = ${factorId} AND user_id = ${userId!}`;
    if (!factor) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });
    const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000);
    if (factor['type'] !== 'sms') {
      // authenticator apps need no challenge; supabase-js asks for one before verifying
      const [c] = await db`INSERT INTO auth.mfa_challenges (factor_id, ip_address, expires_at) VALUES (${factorId}, ${req.ip}, ${expires}) RETURNING id`;
      return reply.send({ id: c!['id'], type: 'totp', expires_at: Math.floor(expires.getTime() / 1000) });
    }
    const settings = authSettings(project);
    if (!settings.enable_mfa_phone) return reply.status(403).send({ error: 'Forbidden', message: 'SMS as a second factor is disabled for this project' });
    const phone = factor['phone'] as string;
    if (!(await allow(`mfa-sms:${factorId}`, 5, 3600)) || !(await allow(`mfa-sms-ip:${project.id}:${req.ip}`, 20, 3600))) {
      return reply.status(429).send({ error: 'Too Many Requests', message: 'Too many codes requested. Wait before trying again.' });
    }
    // test numbers get their fixed code and no SMS (app-store review, CI)
    const testCode = testOtpFor(settings.sms ?? {}, phone);
    const code = testCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [c] = await db`
      INSERT INTO auth.mfa_challenges (factor_id, ip_address, otp_hash, expires_at) VALUES (${factorId}, ${req.ip}, ${sha256(code)}, ${expires}) RETURNING id`;
    if (!testCode) {
      try {
        await sendSmsCode(project.id, settings.sms ?? {}, phone, code);
      } catch (err) {
        req.log.error({ err, projectId: project.id }, 'MFA SMS delivery failed');
        await db`DELETE FROM auth.mfa_challenges WHERE id = ${c!['id']}`;
        return reply.status(502).send({ error: 'Bad Gateway', message: 'Could not send the SMS. Try again later.' });
      }
    }
    await audit(project.id, 'mfa_challenge_sent', req, userId, null, { type: 'phone' });
    return reply.send({ id: c!['id'], type: 'phone', expires_at: Math.floor(expires.getTime() / 1000) });
  });

  server.post('/v1/:projectId/factors/:factorId/verify', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId, claims } = req.ctx;
    const { factorId } = req.params as { factorId: string };
    const body = z.object({ code: z.string().regex(/^\d{6}$/), challenge_id: z.string().uuid().optional() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'A 6-digit code is required' });
    if (!/^[0-9a-f-]{36}$/i.test(factorId)) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });

    const [factor] = await db`SELECT *, type::text AS type FROM auth.mfa_factors WHERE id = ${factorId} AND user_id = ${userId!}`;
    if (!factor) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });

    if (factor['type'] === 'sms') {
      if (!body.data.challenge_id) return reply.status(400).send({ error: 'Bad Request', message: 'challenge_id is required for phone factors' });
      // attempts are counted first, so parallel guesses cannot get past the limit
      const [c] = await db`
        UPDATE auth.mfa_challenges SET attempts = attempts + 1
        WHERE id = ${body.data.challenge_id} AND factor_id = ${factorId} AND verified_at IS NULL AND expires_at > NOW() AND attempts < ${MAX_ATTEMPTS}
        RETURNING otp_hash`;
      const ok = !!c?.['otp_hash'] && timingSafeEqual(Buffer.from(c['otp_hash'] as string), Buffer.from(sha256(body.data.code)));
      if (!ok) {
        await audit(project.id, 'mfa_verify_failed', req, userId, null, { type: 'phone' });
        return reply.status(400).send({ error: 'Invalid Code', message: 'Invalid or expired code' });
      }
      await db`UPDATE auth.mfa_challenges SET verified_at = NOW() WHERE id = ${body.data.challenge_id}`;
      await db`UPDATE auth.mfa_factors SET status = 'verified', updated_at = NOW() WHERE id = ${factorId}`;
      const user = await getUserById(project.id, userId!);
      const session = await issueSession(project, user!, req, { aal: 'aal2', sessionId: claims?.['session_id'] as string, amr: 'sms' });
      await audit(project.id, factor['status'] === 'verified' ? 'mfa_verified' : 'mfa_enrolled', req, userId, session.session_id, { type: 'phone' });
      return reply.send(session);
    }

    const step = verifyTotp(await unsealMfa(project.id, userId!, factor['secret'] as string), body.data.code);
    const lastStep = factor['last_used_step'] === null ? -1 : Number(factor['last_used_step']);
    if (step === null || step <= lastStep) {
      await audit(project.id, 'mfa_verify_failed', req, userId);
      return reply.status(400).send({ error: 'Invalid Code', message: 'Invalid or already used code' });
    }
    await db`UPDATE auth.mfa_factors SET status = 'verified', last_used_step = ${step}, updated_at = NOW() WHERE id = ${factorId}`;
    await db`INSERT INTO auth.mfa_challenges (factor_id, verified_at, ip_address) VALUES (${factorId}, NOW(), ${req.ip})`;

    const user = await getUserById(project.id, userId!);
    const session = await issueSession(project, user!, req, { aal: 'aal2', sessionId: claims?.['session_id'] as string, amr: 'totp' });
    await audit(project.id, factor['status'] === 'verified' ? 'mfa_verified' : 'mfa_enrolled', req, userId, session.session_id);
    return reply.send(session);
  });

  server.delete('/v1/:projectId/factors/:factorId', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId, claims } = req.ctx;
    const { factorId } = req.params as { factorId: string };
    if (!/^[0-9a-f-]{36}$/i.test(factorId)) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });
    const [factor] = await db`SELECT status FROM auth.mfa_factors WHERE id = ${factorId} AND user_id = ${userId!}`;
    if (!factor) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });
    if (factor['status'] === 'verified' && claims?.['aal'] !== 'aal2') {
      return reply.status(403).send({ error: 'MFA Required', message: 'Verify a factor (aal2) before removing it' });
    }
    await db`DELETE FROM auth.mfa_factors WHERE id = ${factorId}`;
    await audit(project.id, 'mfa_unenrolled', req, userId);
    return reply.send({ success: true, id: factorId });
  });
}
