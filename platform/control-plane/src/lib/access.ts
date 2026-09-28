/**
 * Authorization helpers shared by route plugins.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';

export type OrgRole = 'owner' | 'admin' | 'developer' | 'viewer' | 'billing' | 'support';

export interface ProjectAccess {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: string;
  db_schema: string;
  settings: Record<string, any>;
  role: OrgRole;
}

export const WRITE_ROLES: OrgRole[] = ['owner', 'admin', 'developer'];
export const ADMIN_ROLES: OrgRole[] = ['owner', 'admin'];

export function userId(request: FastifyRequest): string {
  return (request.user as { sub: string }).sub;
}

export async function getProjectAccess(projectId: string, uid: string): Promise<ProjectAccess | null> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const [row] = await db<ProjectAccess[]>`
    SELECT p.id, p.organization_id, p.name, p.slug, p.status, p.db_schema, p.settings, om.role
    FROM control_plane.projects p
    JOIN control_plane.organization_members om ON om.organization_id = p.organization_id
    WHERE p.id = ${projectId} AND om.user_id = ${uid} AND p.status <> 'deleting'
  `;
  return row ?? null;
}

/**
 * Loads the project and checks the caller's org role. Sends 404/403 and
 * returns null when access is denied, so callers can `if (!p) return;`.
 */
export async function requireProject(
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  roles: OrgRole[] | null = null,
): Promise<ProjectAccess | null> {
  const p = await getProjectAccess(projectId, userId(request));
  if (!p) {
    void reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    return null;
  }
  if (roles && !roles.includes(p.role)) {
    void reply.status(403).send({ error: 'Forbidden', message: `Requires one of: ${roles.join(', ')}` });
    return null;
  }
  return p;
}

export function ownerRole(schema: string): string {
  return `${schema}_owner`.slice(0, 63);
}

export async function audit(
  request: FastifyRequest,
  event: string,
  target: { type?: string; id?: string | null; projectId?: string | null; orgId?: string | null },
  metadata: Record<string, unknown> = {},
) {
  let actor: string | null = null;
  try { actor = userId(request); } catch { /* unauthenticated */ }
  await db`
    INSERT INTO control_plane.audit_logs
      (event_type, actor_id, actor_type, target_type, target_id, project_id, organization_id, ip_address, user_agent, metadata)
    VALUES (${event}, ${actor}, 'user', ${target.type ?? null}, ${target.id ?? null}, ${target.projectId ?? null},
            ${target.orgId ?? null}, ${request.ip}, ${request.headers['user-agent'] ?? null}, ${db.json(metadata as any)})
  `;
}

export function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: 'Validation Error', message });
}
