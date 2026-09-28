/**
 * Organization Routes
 *
 * GET    /api/organizations                        — List user's organizations
 * POST   /api/organizations                        — Create organization
 * GET    /api/organizations/:id                    — Organization + members
 * POST   /api/organizations/:id/members            — Add an existing platform user by email
 * PATCH  /api/organizations/:id/members/:userId    — Change a member's role
 * DELETE /api/organizations/:id/members/:userId    — Remove a member
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit, userId } from '../lib/access.js';

const createOrgSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  slug: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and hyphens').trim(),
});

const ROLES = ['owner', 'admin', 'developer', 'viewer', 'billing', 'support'] as const;

async function memberRole(orgId: string, uid: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return null;
  const [m] = await db`SELECT role FROM control_plane.organization_members WHERE organization_id = ${orgId} AND user_id = ${uid}`;
  return (m?.['role'] as string) ?? null;
}

function forbid(reply: FastifyReply, msg = 'Only owners and admins can manage members') {
  return reply.status(403).send({ error: 'Forbidden', message: msg });
}

export const organizationRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };

  server.get('/', { ...auth, schema: { tags: ['organizations'], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const orgs = await db`
      SELECT o.id, o.name, o.slug, o.plan, o.created_at, om.role AS member_role,
             (SELECT count(*)::int FROM control_plane.projects p WHERE p.organization_id = o.id AND p.status <> 'deleting') AS project_count
      FROM control_plane.organizations o
      JOIN control_plane.organization_members om ON om.organization_id = o.id
      WHERE om.user_id = ${userId(request)}
      ORDER BY o.created_at ASC
    `;
    return reply.send({ data: orgs });
  });

  server.post('/', { ...auth, schema: { tags: ['organizations'], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const uid = userId(request);
    const input = createOrgSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const { name, slug } = input.data;

    const [existing] = await db`SELECT id FROM control_plane.organizations WHERE slug = ${slug}`;
    if (existing) return reply.status(409).send({ error: 'Conflict', message: 'Slug already taken' });

    const org = await db.begin(async (sql) => {
      const [o] = await sql`INSERT INTO control_plane.organizations (name, slug) VALUES (${name}, ${slug}) RETURNING *`;
      await sql`
        INSERT INTO control_plane.organization_members (organization_id, user_id, role, joined_at, invited_by)
        VALUES (${o!['id']}, ${uid}, 'owner', NOW(), ${uid})`;
      return o!;
    });
    await audit(request, 'organization.created', { type: 'organization', id: org['id'] as string, orgId: org['id'] as string }, { name, slug });
    return reply.status(201).send(org);
  });

  server.get('/:id', { ...auth, schema: { tags: ['organizations'], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const role = await memberRole(id, userId(request));
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });

    const [org] = await db`SELECT * FROM control_plane.organizations WHERE id = ${id}`;
    const members = await db`
      SELECT pu.id, pu.email, pu.name, om.role, om.joined_at
      FROM control_plane.organization_members om
      JOIN control_plane.platform_users pu ON pu.id = om.user_id
      WHERE om.organization_id = ${id}
      ORDER BY om.joined_at ASC NULLS LAST
    `;
    return reply.send({ ...org, member_role: role, members });
  });

  server.post('/:id/members', { ...auth, schema: { tags: ['organizations'], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const uid = userId(request);
    const role = await memberRole(id, uid);
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    if (!['owner', 'admin'].includes(role)) return forbid(reply);

    const input = z.object({ email: z.string().email().toLowerCase(), role: z.enum(ROLES).default('developer') }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    if (input.data.role === 'owner' && role !== 'owner') return forbid(reply, 'Only owners can add owners');

    const [target] = await db`SELECT id FROM control_plane.platform_users WHERE email = ${input.data.email}`;
    if (!target) return reply.status(404).send({ error: 'Not Found', message: 'No platform user with that email. Ask them to sign up first.' });

    const [member] = await db`
      INSERT INTO control_plane.organization_members (organization_id, user_id, role, joined_at, invited_by)
      VALUES (${id}, ${target['id'] as string}, ${input.data.role}, NOW(), ${uid})
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING user_id, role
    `;
    await audit(request, 'organization.member_added', { type: 'platform_user', id: target['id'] as string, orgId: id }, { role: input.data.role });
    return reply.status(201).send(member);
  });

  server.patch('/:id/members/:memberId', { ...auth, schema: { tags: ['organizations'], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const { id, memberId } = request.params as { id: string; memberId: string };
    const role = await memberRole(id, userId(request));
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    if (role !== 'owner') return forbid(reply, 'Only owners can change roles');
    const input = z.object({ role: z.enum(ROLES) }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'Invalid role' });

    if (input.data.role !== 'owner') {
      const [{ owners }] = await db`
        SELECT count(*)::int AS owners FROM control_plane.organization_members
        WHERE organization_id = ${id} AND role = 'owner' AND user_id <> ${memberId}` as any;
      if (owners === 0) return reply.status(409).send({ error: 'Conflict', message: 'An organization must keep at least one owner' });
    }
    const [m] = await db`
      UPDATE control_plane.organization_members SET role = ${input.data.role}
      WHERE organization_id = ${id} AND user_id = ${memberId} RETURNING user_id, role`;
    if (!m) return reply.status(404).send({ error: 'Not Found', message: 'Member not found' });
    return reply.send(m);
  });

  server.delete('/:id/members/:memberId', { ...auth, schema: { tags: ['organizations'], security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const { id, memberId } = request.params as { id: string; memberId: string };
    const uid = userId(request);
    const role = await memberRole(id, uid);
    if (!role) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    if (!['owner', 'admin'].includes(role) && memberId !== uid) return forbid(reply);

    const [{ owners }] = await db`
      SELECT count(*)::int AS owners FROM control_plane.organization_members
      WHERE organization_id = ${id} AND role = 'owner' AND user_id <> ${memberId}` as any;
    if (owners === 0) return reply.status(409).send({ error: 'Conflict', message: 'An organization must keep at least one owner' });

    await db`DELETE FROM control_plane.organization_members WHERE organization_id = ${id} AND user_id = ${memberId}`;
    await audit(request, 'organization.member_removed', { type: 'platform_user', id: memberId, orgId: id });
    return reply.send({ success: true });
  });
};
