/**
 * Organization invitations.
 *
 * Org side (owners / admins):
 *   GET    /api/organizations/:id/invitations              — open invitations
 *   POST   /api/organizations/:id/invitations              — invite { email, role } (emails a link)
 *   DELETE /api/organizations/:id/invitations/:inviteId    — revoke
 *
 * Invitee side (signed in, with the account whose email was invited):
 *   GET    /api/invitations/:token          — what the link is for
 *   POST   /api/invitations/:token/accept   — join the organization
 *   POST   /api/invitations/:token/decline
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit, userId } from '../lib/access.js';
import { config } from '../config.js';
import { jobsQueue } from '../lib/queues.js';

const ROLES = ['owner', 'admin', 'developer', 'viewer', 'billing', 'support'] as const;
const INVITE_DAYS = 7;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tags = { tags: ['organizations'], security: [{ bearerAuth: [] }] };

async function memberRole(orgId: string, uid: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return null;
  const [m] = await db`SELECT role FROM control_plane.organization_members WHERE organization_id = ${orgId} AND user_id = ${uid}`;
  return (m?.['role'] as string) ?? null;
}

function inviteStatus(i: Record<string, any>): 'pending' | 'accepted' | 'revoked' | 'expired' {
  if (i['accepted_at']) return 'accepted';
  if (i['revoked_at']) return 'revoked';
  return new Date(i['expires_at']) < new Date() ? 'expired' : 'pending';
}

/** Routes mounted under /api/organizations */
export const orgInvitationRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate], schema: tags };

  server.get('/:id/invitations', auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const role = await memberRole(id, userId(request));
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    if (!['owner', 'admin'].includes(role)) return reply.status(403).send({ error: 'Forbidden', message: 'Only owners and admins can see invitations' });
    const rows = await db`
      SELECT i.id, i.email, i.role, i.expires_at, i.created_at, pu.email AS invited_by_email
      FROM control_plane.organization_invitations i
      LEFT JOIN control_plane.platform_users pu ON pu.id = i.invited_by
      WHERE i.organization_id = ${id} AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
      ORDER BY i.created_at DESC`;
    return reply.send({ data: rows });
  });

  server.post('/:id/invitations', auth, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = userId(request);
    const role = await memberRole(id, uid);
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    if (!['owner', 'admin'].includes(role)) return reply.status(403).send({ error: 'Forbidden', message: 'Only owners and admins can invite' });
    const input = z.object({ email: z.string().email().max(255).transform((e) => e.toLowerCase().trim()), role: z.enum(ROLES).default('developer') }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    if (input.data.role === 'owner' && role !== 'owner') return reply.status(403).send({ error: 'Forbidden', message: 'Only owners can invite owners' });

    const [already] = await db`
      SELECT 1 FROM control_plane.organization_members om JOIN control_plane.platform_users pu ON pu.id = om.user_id
      WHERE om.organization_id = ${id} AND lower(pu.email) = ${input.data.email}`;
    if (already) return reply.status(409).send({ error: 'Conflict', message: 'That person is already a member' });

    const token = randomBytes(32).toString('base64url');
    const invite = await db.begin(async (sql) => {
      // a new invitation replaces an open one for the same address
      await sql`UPDATE control_plane.organization_invitations SET revoked_at = NOW()
                WHERE organization_id = ${id} AND lower(email) = ${input.data.email} AND accepted_at IS NULL AND revoked_at IS NULL`;
      const [i] = await sql`
        INSERT INTO control_plane.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
        VALUES (${id}, ${input.data.email}, ${input.data.role}, ${sha256(token)}, ${uid}, NOW() + make_interval(days => ${INVITE_DAYS}))
        RETURNING id, email, role, expires_at, created_at`;
      return i!;
    });

    const [org] = await db`SELECT name FROM control_plane.organizations WHERE id = ${id}`;
    const [me] = await db`SELECT email, name FROM control_plane.platform_users WHERE id = ${uid}`;
    const url = `${config.publicUrl.replace(/\/$/, '')}/invite/${token}`;
    const who = (me?.['name'] as string) || (me?.['email'] as string) || 'Someone';
    await jobsQueue().add('email.send', {
      payload: {
        to: input.data.email,
        subject: `You're invited to ${org?.['name']} on OwnDatabase`,
        text: `${who} invited you to join ${org?.['name']} as ${input.data.role}.\n\nAccept: ${url}\n\nThe link expires in ${INVITE_DAYS} days.`,
      },
    }).catch((err) => request.log.warn({ err }, 'could not queue invitation email'));
    await audit(request, 'organization.invitation_created', { type: 'invitation', id: invite['id'] as string, orgId: id }, { email: input.data.email, role: input.data.role });
    // The link is also returned once, so it can be shared another way
    return reply.status(201).send({ ...invite, invite_url: url });
  });

  server.delete('/:id/invitations/:inviteId', auth, async (request, reply) => {
    const { id, inviteId } = request.params as { id: string; inviteId: string };
    const role = await memberRole(id, userId(request));
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    if (!['owner', 'admin'].includes(role)) return reply.status(403).send({ error: 'Forbidden', message: 'Only owners and admins can revoke invitations' });
    if (!/^[0-9a-f-]{36}$/i.test(inviteId)) return reply.status(404).send({ error: 'Not Found', message: 'Invitation not found' });
    const [i] = await db`
      UPDATE control_plane.organization_invitations SET revoked_at = NOW()
      WHERE id = ${inviteId} AND organization_id = ${id} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`;
    if (!i) return reply.status(404).send({ error: 'Not Found', message: 'Invitation not found' });
    await audit(request, 'organization.invitation_revoked', { type: 'invitation', id: inviteId, orgId: id });
    return reply.send({ success: true });
  });
};

/** Routes mounted under /api/invitations */
export const invitationRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate], schema: tags };

  async function load(token: string) {
    const [i] = await db`
      SELECT i.*, o.name AS organization_name, o.slug AS organization_slug, pu.email AS invited_by_email
      FROM control_plane.organization_invitations i
      JOIN control_plane.organizations o ON o.id = i.organization_id
      LEFT JOIN control_plane.platform_users pu ON pu.id = i.invited_by
      WHERE i.token_hash = ${sha256(token)}`;
    return i ?? null;
  }

  server.get('/:token', auth, async (request, reply) => {
    const i = await load((request.params as { token: string }).token);
    if (!i) return reply.status(404).send({ error: 'Not Found', message: 'Invitation not found' });
    const [me] = await db`SELECT email FROM control_plane.platform_users WHERE id = ${userId(request)}`;
    return reply.send({
      organization_id: i['organization_id'], organization_name: i['organization_name'], organization_slug: i['organization_slug'],
      email: i['email'], role: i['role'], invited_by_email: i['invited_by_email'], expires_at: i['expires_at'],
      status: inviteStatus(i),
      email_matches: String(me?.['email'] ?? '').toLowerCase() === String(i['email']).toLowerCase(),
    });
  });

  server.post('/:token/accept', auth, async (request, reply) => {
    const uid = userId(request);
    const i = await load((request.params as { token: string }).token);
    if (!i) return reply.status(404).send({ error: 'Not Found', message: 'Invitation not found' });
    const status = inviteStatus(i);
    if (status !== 'pending') return reply.status(410).send({ error: 'Gone', message: `This invitation has ${status === 'expired' ? 'expired' : `been ${status}`}` });
    const [me] = await db`SELECT email FROM control_plane.platform_users WHERE id = ${uid}`;
    if (String(me?.['email'] ?? '').toLowerCase() !== String(i['email']).toLowerCase()) {
      return reply.status(403).send({ error: 'Forbidden', message: `This invitation was sent to ${i['email']}. Sign in with that account to accept it.` });
    }
    const joined = await db.begin(async (sql) => {
      const [claimed] = await sql`
        UPDATE control_plane.organization_invitations SET accepted_at = NOW(), accepted_by = ${uid}
        WHERE id = ${i['id'] as string} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`;
      if (!claimed) return false;
      await sql`
        INSERT INTO control_plane.organization_members (organization_id, user_id, role, joined_at, invited_by)
        VALUES (${i['organization_id'] as string}, ${uid}, ${i['role'] as string}, NOW(), ${i['invited_by'] as string | null})
        ON CONFLICT (organization_id, user_id) DO NOTHING`;
      return true;
    });
    if (!joined) return reply.status(410).send({ error: 'Gone', message: 'This invitation is no longer valid' });
    await audit(request, 'organization.invitation_accepted', { type: 'invitation', id: i['id'] as string, orgId: i['organization_id'] as string }, { role: i['role'] });
    return reply.send({ organization_id: i['organization_id'], role: i['role'] });
  });

  server.post('/:token/decline', auth, async (request, reply) => {
    const uid = userId(request);
    const i = await load((request.params as { token: string }).token);
    if (!i || inviteStatus(i) !== 'pending') return reply.status(404).send({ error: 'Not Found', message: 'Invitation not found' });
    const [me] = await db`SELECT email FROM control_plane.platform_users WHERE id = ${uid}`;
    if (String(me?.['email'] ?? '').toLowerCase() !== String(i['email']).toLowerCase()) return reply.status(403).send({ error: 'Forbidden', message: 'Not your invitation' });
    await db`UPDATE control_plane.organization_invitations SET revoked_at = NOW() WHERE id = ${i['id'] as string}`;
    await audit(request, 'organization.invitation_declined', { type: 'invitation', id: i['id'] as string, orgId: i['organization_id'] as string });
    return reply.send({ success: true });
  });
};
