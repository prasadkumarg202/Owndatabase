/**
 * TOTP multi-factor authentication.
 *
 *   GET    /v1/:projectId/factors
 *   POST   /v1/:projectId/factors                 { friendly_name? }  → secret + otpauth URI
 *   POST   /v1/:projectId/factors/:factorId/verify { code }           → aal2 session
 *   DELETE /v1/:projectId/factors/:factorId                            (needs aal2)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { userContext } from '../middleware/auth.js';
import { audit, authSettings, getUserById, issueSession } from '../lib/session.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { sealMfa, unsealMfa } from '../lib/crypto.js';

export default async function (server: FastifyInstance) {
  server.get('/v1/:projectId/factors', { preValidation: [userContext] }, async (req, reply) => {
    const rows = await db`SELECT id, type AS factor_type, status, friendly_name, created_at, updated_at FROM auth.mfa_factors WHERE user_id = ${req.ctx.userId!} ORDER BY created_at`;
    return reply.send({ data: rows, all: rows, totp: rows.filter((r) => r['factor_type'] === 'totp') });
  });

  server.post('/v1/:projectId/factors', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId, claims } = req.ctx;
    if (!authSettings(project).enable_mfa) return reply.status(403).send({ error: 'Forbidden', message: 'MFA is disabled for this project' });
    const body = z.object({ factor_type: z.literal('totp').default('totp'), friendly_name: z.string().max(100).optional(), issuer: z.string().max(100).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'Only totp factors are supported' });

    const [{ verified }] = await db`SELECT count(*)::int AS verified FROM auth.mfa_factors WHERE user_id = ${userId!} AND status = 'verified'` as any;
    if (verified > 0 && claims?.['aal'] !== 'aal2') {
      return reply.status(403).send({ error: 'MFA Required', message: 'Verify an existing factor before adding another' });
    }
    // Drop abandoned enrolments
    await db`DELETE FROM auth.mfa_factors WHERE user_id = ${userId!} AND status = 'unverified'`;

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

  server.post('/v1/:projectId/factors/:factorId/verify', { preValidation: [userContext] }, async (req, reply) => {
    const { project, userId, claims } = req.ctx;
    const { factorId } = req.params as { factorId: string };
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bad Request', message: 'A 6-digit code is required' });
    if (!/^[0-9a-f-]{36}$/i.test(factorId)) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });

    const [factor] = await db`SELECT * FROM auth.mfa_factors WHERE id = ${factorId} AND user_id = ${userId!}`;
    if (!factor) return reply.status(404).send({ error: 'Not Found', message: 'Factor not found' });

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
