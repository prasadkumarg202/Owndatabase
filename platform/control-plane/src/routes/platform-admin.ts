/**
 * Platform overview for platform administrators (dashboard → Platform admin). Read-only: lists every
 * user, organization and project. Opening a project's data still needs membership of its organization.
 *
 *   GET /api/admin/overview                 counts
 *   GET /api/admin/projects?search=&limit=  every project with its organization, owner and end-user count
 *   GET /api/admin/users?search=&limit=     every platform user with organization / project counts
 */
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { db } from '../lib/db.js';
import { requirePlatformAdmin } from '../lib/access.js';

export const platformAdminRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const s = (summary: string) => ({ schema: { tags: ['admin'], summary, security: [{ bearerAuth: [] }] } });
  const opts = (q: Record<string, string | undefined>) => ({
    search: q['search'] ? `%${q['search']}%` : null,
    limit: Math.min(Math.max(Number(q['limit']) || 200, 1), 1000),
  });

  server.get('/api/admin/overview', { ...auth, ...s('Platform counts (platform admins)') }, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    const [r] = await db`
      SELECT (SELECT count(*)::int FROM control_plane.platform_users) AS users,
             (SELECT count(*)::int FROM control_plane.organizations) AS organizations,
             (SELECT count(*)::int FROM control_plane.projects WHERE status <> 'deleting') AS projects,
             (SELECT count(*)::int FROM control_plane.projects WHERE status = 'active') AS active_projects,
             (SELECT count(*)::int FROM auth.users WHERE deleted_at IS NULL) AS end_users`;
    return reply.send(r);
  });

  server.get('/api/admin/projects', { ...auth, ...s('All projects (platform admins)') }, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    const { search, limit } = opts(request.query as Record<string, string>);
    const rows = await db`
      SELECT p.id, p.name, p.slug, p.status::text AS status, p.created_at, p.parent_project_id, p.branch_name,
             o.id AS organization_id, o.name AS organization_name,
             (SELECT pu.email FROM control_plane.organization_members m JOIN control_plane.platform_users pu ON pu.id = m.user_id
              WHERE m.organization_id = o.id AND m.role = 'owner' ORDER BY m.joined_at NULLS LAST LIMIT 1) AS owner_email,
             (SELECT count(*)::int FROM auth.users u WHERE u.project_id = p.id AND u.deleted_at IS NULL) AS end_users
      FROM control_plane.projects p JOIN control_plane.organizations o ON o.id = p.organization_id
      WHERE p.status <> 'deleting'
        ${search ? db`AND (p.name ILIKE ${search} OR p.slug ILIKE ${search} OR o.name ILIKE ${search})` : db``}
      ORDER BY p.created_at DESC LIMIT ${limit}`;
    return reply.send({ data: rows });
  });

  server.get('/api/admin/users', { ...auth, ...s('All platform users (platform admins)') }, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    const { search, limit } = opts(request.query as Record<string, string>);
    const rows = await db`
      SELECT u.id, u.email, u.name, u.created_at, u.last_login_at, u.is_active, u.is_platform_admin,
             (SELECT count(*)::int FROM control_plane.organization_members m WHERE m.user_id = u.id) AS organizations,
             (SELECT count(*)::int FROM control_plane.projects p JOIN control_plane.organization_members m ON m.organization_id = p.organization_id
              WHERE m.user_id = u.id AND p.status <> 'deleting') AS projects
      FROM control_plane.platform_users u
      WHERE TRUE ${search ? db`AND (u.email ILIKE ${search} OR u.name ILIKE ${search})` : db``}
      ORDER BY u.created_at DESC LIMIT ${limit}`;
    return reply.send({ data: rows });
  });
};
