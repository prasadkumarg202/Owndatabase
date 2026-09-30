/**
 * Project Routes
 *
 * GET    /api/projects                     — List projects visible to the user
 * POST   /api/projects                     — Create + provision a project (returns default API keys once)
 * GET    /api/projects/:id                 — Project details incl. service endpoints
 * PATCH  /api/projects/:id                 — Update name / settings
 * DELETE /api/projects/:id?confirm=<slug>  — Delete project and all its data
 * POST   /api/projects/:id/pause | resume  — Pause / resume data-plane access
 * POST   /api/projects/:id/provision       — Re-run (idempotent) provisioning
 * GET    /api/projects/:id/connection      — Direct PostgreSQL connection info (owners/admins)
 * GET    /api/projects/:id/auth-config     — End-user auth settings
 * PUT    /api/projects/:id/auth-config     — Update end-user auth settings
 * GET    /api/projects/:id/audit-logs      — Project audit trail
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { ADMIN_ROLES, audit, ownerRole, requireProject, userId } from '../lib/access.js';
import { sealAuthSettings } from '../lib/vault.js';
import { dropProjectSchema, generateApiKey } from '../lib/provision.js';
import { closeProjectDb, ensureProjectProvisioned, getProjectDbPassword, projectConnectionUrl } from '../lib/project-db.js';
import { redis } from '../lib/redis.js';
import { cleanLimits } from './limits.js';
import { BRANCH_REQUEST_TOKEN, planLimitsForNewProject, projectCapError } from '../lib/billing.js';

const REGIONS = ['local', 'in-south-1', 'us-east-1', 'eu-west-1'] as const;

const createProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  slug: z.string().min(3).max(40).regex(/^[a-z][a-z0-9-]*$/, 'Slug must start with a letter and contain only lowercase letters, numbers and hyphens').trim().optional(),
  organization_id: z.string().uuid().optional(),
  region: z.enum(REGIONS).default('local'),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  settings: z.record(z.unknown()).optional(),
});

export const DEFAULT_AUTH_CONFIG = {
  enable_signup: true,
  require_email_confirmation: false,
  password_min_length: 8,
  jwt_expiry: 3600,
  enable_magic_link: true,
  enable_anonymous_sign_ins: false,
  enable_mfa: true,
  max_failed_logins: 5,
  lockout_minutes: 15,
  site_url: '',
  redirect_urls: [] as string[],
  providers: {
    google: { enabled: false, client_id: '', client_secret: '' },
    github: { enabled: false, client_id: '', client_secret: '' },
  },
  enable_phone_auth: false,
  sms_otp_expiry_minutes: Number(process.env['SMS_OTP_EXPIRY_MINUTES']) || 10,
  sms: {
    provider: 'none' as 'none' | 'twilio' | 'webhook' | 'log',
    twilio_account_sid: '', twilio_auth_token: '', twilio_from: '', twilio_messaging_service_sid: '',
    webhook_url: '', webhook_secret: '',
    template: process.env['SMS_TEMPLATE'] || 'Your verification code is {{code}}',
    test_otp: '',
  },
  // bot protection (Cloudflare Turnstile or hCaptcha) on sign-up, sign-in, OTP and recovery
  captcha: { enabled: false, provider: 'turnstile' as 'turnstile' | 'hcaptcha', secret: '' },
};

const SMS_SECRETS = ['twilio_auth_token', 'webhook_secret'] as const;
const MASK = '••••••••';

/** OAuth providers the auth service supports (auth-service/src/routes/oauth.ts) */
export const OAUTH_PROVIDERS = [
  'google', 'github', 'gitlab', 'bitbucket', 'azure', 'apple', 'facebook', 'discord',
  'linkedin_oidc', 'slack_oidc', 'x', 'twitter', 'spotify', 'twitch', 'keycloak',
] as const;

const authConfigSchema = z.object({
  enable_signup: z.boolean(),
  require_email_confirmation: z.boolean(),
  password_min_length: z.number().int().min(6).max(128),
  jwt_expiry: z.number().int().min(300).max(86400 * 7),
  enable_magic_link: z.boolean(),
  enable_anonymous_sign_ins: z.boolean(),
  enable_mfa: z.boolean(),
  max_failed_logins: z.number().int().min(1).max(100),
  lockout_minutes: z.number().int().min(1).max(1440),
  site_url: z.string().max(500),
  redirect_urls: z.array(z.string().max(500)).max(50),
  providers: z.record(z.enum(OAUTH_PROVIDERS), z.object({
    enabled: z.boolean(),
    client_id: z.string().max(500),
    client_secret: z.string().max(4000),
    url: z.string().max(500).refine((u) => u === '' || /^https?:\/\//.test(u), 'provider url must be an http(s) URL'),
    additional_client_ids: z.string().max(2000),
    team_id: z.string().max(20),
    key_id: z.string().max(20),
  }).partial()),
  enable_phone_auth: z.boolean(),
  sms_otp_expiry_minutes: z.number().int().min(1).max(60),
  sms: z.object({
    provider: z.enum(['none', 'twilio', 'webhook', 'log']),
    twilio_account_sid: z.string().max(64),
    twilio_auth_token: z.string().max(128),
    twilio_from: z.string().max(32),
    twilio_messaging_service_sid: z.string().max(64),
    webhook_url: z.string().max(500).refine((u) => u === '' || /^https?:\/\//.test(u), 'webhook_url must be an http(s) URL'),
    webhook_secret: z.string().max(200),
    template: z.string().max(300).refine((t) => /\{\{\s*\.?code\s*\}\}/i.test(t), 'template must contain {{code}} (or {{ .Code }})'),
    test_otp: z.string().max(2000).refine((v) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).every((pair) => /^\+?[\d\s()-]{8,20}=\d{6}$/.test(pair)), 'test numbers: +919999999999=123456, comma-separated'),
  }).partial(),
  captcha: z.object({ enabled: z.boolean(), provider: z.enum(['turnstile', 'hcaptcha']), secret: z.string().max(200) }).partial(),
}).partial();

export function endpointsFor(projectId: string) {
  const base = config.publicUrl.replace(/\/$/, '');
  const ws = base.replace(/^http/, 'ws');
  return {
    rest_url: `${base}/rest/v1/${projectId}`,
    auth_url: `${base}/auth/v1/${projectId}`,
    storage_url: `${base}/storage/v1/${projectId}`,
    realtime_url: `${ws}/realtime?project_id=${projectId}`,
    functions_url: `${base}/functions/v1/${projectId}`,
    openapi_url: `${base}/rest/v1/${projectId}/openapi.json`,
  };
}

function redactAuthConfig(cfg: any) {
  const clone = JSON.parse(JSON.stringify(cfg));
  for (const p of Object.values(clone.providers ?? {}) as any[]) {
    if (p?.client_secret) p.client_secret = MASK;
  }
  for (const k of SMS_SECRETS) if (clone.sms?.[k]) clone.sms[k] = MASK;
  if (clone.captcha?.secret) clone.captcha.secret = MASK;
  return clone;
}

async function invalidateProjectCache(projectId: string) {
  await redis.publish('odb:project-changed', projectId).catch(() => {});
}

export const projectRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const tags = { tags: ['projects'], security: [{ bearerAuth: [] }] };

  server.get('/', { ...auth, schema: { ...tags, summary: 'List projects' } }, async (request, reply) => {
    const projects = await db`
      SELECT p.id, p.name, p.slug, p.status, p.region, p.db_schema, p.api_endpoint, p.created_at, p.updated_at,
             p.organization_id, o.name AS organization_name, o.slug AS organization_slug, om.role AS member_role
      FROM control_plane.projects p
      JOIN control_plane.organizations o ON o.id = p.organization_id
      JOIN control_plane.organization_members om ON om.organization_id = o.id
      WHERE om.user_id = ${userId(request)} AND p.status <> 'deleting'
      ORDER BY p.created_at DESC
    `;
    return reply.send({ data: projects, count: projects.length });
  });

  server.post('/', { ...auth, schema: { ...tags, summary: 'Create a new project' } }, async (request, reply) => {
    const uid = userId(request);
    const input = createProjectSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    }
    const { name, region } = input.data;
    let { organization_id, slug } = input.data;

    if (!organization_id) {
      const [first] = await db`
        SELECT organization_id FROM control_plane.organization_members
        WHERE user_id = ${uid} AND role IN ('owner','admin') ORDER BY invited_at ASC LIMIT 1`;
      if (!first) return reply.status(400).send({ error: 'Validation Error', message: 'organization_id is required' });
      organization_id = first['organization_id'] as string;
    }

    const [membership] = await db`
      SELECT role FROM control_plane.organization_members WHERE organization_id = ${organization_id} AND user_id = ${uid}`;
    if (!membership) return reply.status(403).send({ error: 'Forbidden', message: 'No access to this organization' });
    if (!['owner', 'admin'].includes(membership['role'] as string)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only owners and admins can create projects' });
    }

    slug ??= name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 30) || 'project';

    const [existing] = await db`
      SELECT id FROM control_plane.projects WHERE organization_id = ${organization_id} AND slug = ${slug}`;
    if (existing) return reply.status(409).send({ error: 'Conflict', message: 'A project with this slug already exists' });
    // billing (when enabled): the plan's project cap; branches do not count
    const isBranch = request.headers['x-odb-branch'] === BRANCH_REQUEST_TOKEN;
    const cap = isBranch ? null : await projectCapError(organization_id);
    if (cap) return reply.status(402).send({ error: 'Plan Limit', message: cap });
    const planLimits = await planLimitsForNewProject(organization_id);

    // Schema names are global in the shared database, so add a short suffix
    // when another organization already uses the same slug.
    let dbSchema = `project_${slug.replace(/-/g, '_')}`.slice(0, 50);
    const [clash] = await db`SELECT 1 FROM pg_namespace WHERE nspname = ${dbSchema}
                             UNION SELECT 1 FROM control_plane.projects WHERE db_schema = ${dbSchema}`;
    if (clash) dbSchema = `${dbSchema}_${Math.random().toString(36).slice(2, 7)}`;

    const [project] = await db`
      INSERT INTO control_plane.projects (organization_id, name, slug, status, region, db_name, db_schema, settings)
      VALUES (${organization_id}, ${name}, ${slug}, 'creating', ${region}, current_database(), ${dbSchema},
              ${db.json({ auth: DEFAULT_AUTH_CONFIG, limits: cleanLimits(planLimits ?? config.defaultProjectLimits) } as any)})
      RETURNING *
    `;
    const projectId = project!['id'] as string;

    try {
      await ensureProjectProvisioned(projectId, dbSchema);
    } catch (err) {
      logger.error({ err, projectId }, 'Project provisioning failed');
      await db`UPDATE control_plane.projects SET status = 'failed' WHERE id = ${projectId}`;
      return reply.status(500).send({ error: 'Provisioning Failed', message: (err as Error).message });
    }

    const endpoints = endpointsFor(projectId);
    const anon = generateApiKey('anon');
    const service = generateApiKey('service_role');
    await db.begin(async (sql) => {
      await sql`
        INSERT INTO control_plane.environments (project_id, name, type, is_default)
        VALUES (${projectId}, 'development', 'development', true) ON CONFLICT DO NOTHING`;
      await sql`
        INSERT INTO control_plane.api_keys (project_id, name, key_hash, key_prefix, type, created_by) VALUES
          (${projectId}, 'Default anon key', ${anon.hash}, ${anon.prefix}, 'anon', ${uid}),
          (${projectId}, 'Default service key', ${service.hash}, ${service.prefix}, 'service_role', ${uid})`;
      await sql`
        UPDATE control_plane.projects
        SET status = 'active', api_endpoint = ${endpoints.rest_url}, auth_endpoint = ${endpoints.auth_url},
            storage_endpoint = ${endpoints.storage_url}, realtime_endpoint = ${endpoints.realtime_url}
        WHERE id = ${projectId}`;
      await sql`
        INSERT INTO control_plane.backup_configs (project_id) VALUES (${projectId}) ON CONFLICT DO NOTHING`;
    });

    await audit(request, 'project.created', { type: 'project', id: projectId, projectId, orgId: organization_id }, { name, slug });
    logger.info({ uid, projectId, slug }, 'Project created');

    const [created] = await db`SELECT * FROM control_plane.projects WHERE id = ${projectId}`;
    const { metadata: _m, ...safe } = created as any;
    return reply.status(201).send({
      ...safe,
      settings: { ...safe.settings, auth: redactAuthConfig(safe.settings?.auth ?? DEFAULT_AUTH_CONFIG) },
      endpoints,
      api_keys: { anon: anon.key, service_role: service.key },
      warning: 'API keys are shown only once. Store them securely.',
    });
  });

  server.get('/:id', { ...auth, schema: { ...tags, summary: 'Get project details' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const [project] = await db`
      SELECT p.*, o.name AS organization_name, o.slug AS organization_slug
      FROM control_plane.projects p JOIN control_plane.organizations o ON o.id = p.organization_id
      WHERE p.id = ${id}`;
    const { metadata: _m, ...safe } = project as any;
    const [counts] = await db`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = ${p.db_schema} AND table_type = 'BASE TABLE') AS tables,
        (SELECT count(*)::int FROM auth.users WHERE project_id = ${id} AND deleted_at IS NULL) AS users,
        (SELECT count(*)::int FROM storage.buckets WHERE project_id = ${id}) AS buckets,
        (SELECT count(*)::int FROM control_plane.api_keys WHERE project_id = ${id} AND is_active) AS api_keys,
        (SELECT count(*)::int FROM control_plane.functions WHERE project_id = ${id}) AS functions,
        (SELECT pg_size_pretty(COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${p.db_schema} AND c.relkind IN ('r','m')) AS db_size
    `;
    return reply.send({
      ...safe,
      settings: { ...safe.settings, auth: redactAuthConfig({ ...DEFAULT_AUTH_CONFIG, ...(safe.settings?.auth ?? {}) }) },
      member_role: p.role,
      endpoints: endpointsFor(id),
      stats: counts,
    });
  });

  server.patch('/:id', { ...auth, schema: { ...tags, summary: 'Update project' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const input = updateProjectSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const settings = input.data.settings ? { ...p.settings, ...input.data.settings, auth: p.settings?.['auth'] } : p.settings;
    const [project] = await db`
      UPDATE control_plane.projects SET name = ${input.data.name ?? p.name}, settings = ${db.json(settings as any)}
      WHERE id = ${id} RETURNING id, name, slug, status, settings, updated_at`;
    await audit(request, 'project.updated', { type: 'project', id, projectId: id });
    return reply.send(project);
  });

  server.delete('/:id', { ...auth, schema: { ...tags, summary: 'Delete project (requires ?confirm=<slug>)' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ['owner']);
    if (!p) return;
    const { confirm } = request.query as { confirm?: string };
    if (confirm !== p.slug) {
      return reply.status(400).send({ error: 'Confirmation Required', message: `Pass ?confirm=${p.slug} to delete this project and all of its data` });
    }
    // a project's branches go with it
    const branches = await db`SELECT id, db_schema FROM control_plane.projects WHERE parent_project_id = ${id}`;
    for (const b of [...branches, { id, db_schema: p.db_schema }]) {
      await db`UPDATE control_plane.projects SET status = 'deleting' WHERE id = ${b['id'] as string}`;
      await invalidateProjectCache(b['id'] as string);
      await closeProjectDb(b['id'] as string);
      await dropProjectSchema(b['db_schema'] as string);
      if (b['id'] !== id) await db`DELETE FROM control_plane.projects WHERE id = ${b['id'] as string}`;
      // crypto-shred: without its data keys the project's secrets (also in old backups) can't be decrypted
      await db`DELETE FROM control_plane.vault_keys WHERE scope = ${b['id'] as string}`;
    }
    await audit(request, 'project.deleted', { type: 'project', id, orgId: p.organization_id }, { slug: p.slug });
    await db`DELETE FROM control_plane.projects WHERE id = ${id}`;
    return reply.send({ success: true });
  });

  for (const action of ['pause', 'resume'] as const) {
    server.post(`/:id/${action}`, { ...auth, schema: { ...tags, summary: `${action} project` } }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const p = await requireProject(request, reply, id, ADMIN_ROLES);
      if (!p) return;
      const status = action === 'pause' ? 'paused' : 'active';
      const [row] = await db`UPDATE control_plane.projects SET status = ${status} WHERE id = ${id} RETURNING id, status`;
      await invalidateProjectCache(id);
      await audit(request, `project.${action}d`, { type: 'project', id, projectId: id });
      return reply.send(row);
    });
  }

  server.post('/:id/provision', { ...auth, schema: { ...tags, summary: 'Re-run provisioning' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    await ensureProjectProvisioned(id, p.db_schema);
    await db`UPDATE control_plane.projects SET status = 'active' WHERE id = ${id} AND status IN ('failed','creating')`;
    return reply.send({ success: true, schema: p.db_schema });
  });

  server.get('/:id/connection', { ...auth, schema: { ...tags, summary: 'Direct database connection details' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const password = await getProjectDbPassword(id);
    const host = new URL(config.databaseUrl);
    return reply.send({
      host: host.hostname, port: Number(host.port || 5432), database: host.pathname.slice(1),
      user: ownerRole(p.db_schema), password, schema: p.db_schema,
      connection_string: projectConnectionUrl(p.db_schema, password),
      note: 'This role can only access the project schema. Expose PostgreSQL/PgBouncer on your network to connect from outside.',
    });
  });

  server.get('/:id/auth-config', { ...auth, schema: { ...tags, summary: 'Get end-user auth settings' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    return reply.send(redactAuthConfig({ ...DEFAULT_AUTH_CONFIG, ...(p.settings?.['auth'] ?? {}) }));
  });

  server.put('/:id/auth-config', { ...auth, schema: { ...tags, summary: 'Update end-user auth settings' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const input = authConfigSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });

    const current: any = { ...DEFAULT_AUTH_CONFIG, ...(p.settings?.['auth'] ?? {}) };
    const next: any = { ...current, ...input.data, providers: { ...current.providers } };
    for (const [name, prov] of Object.entries(input.data.providers ?? {})) {
      const merged = { ...current.providers?.[name], ...prov };
      // A redacted secret coming back from the UI means "unchanged"
      if (prov?.client_secret === MASK) merged.client_secret = current.providers?.[name]?.client_secret ?? '';
      next.providers[name] = merged;
    }
    if (input.data.sms) {
      next.sms = { ...DEFAULT_AUTH_CONFIG.sms, ...current.sms, ...input.data.sms };
      for (const k of SMS_SECRETS) if (input.data.sms[k] === MASK) next.sms[k] = current.sms?.[k] ?? '';
      if (next.sms.provider === 'twilio' && !(next.sms.twilio_account_sid && next.sms.twilio_auth_token && (next.sms.twilio_from || next.sms.twilio_messaging_service_sid))) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Twilio needs an account SID, auth token and a from number or messaging service SID' });
      }
      if (next.sms.provider === 'webhook' && !next.sms.webhook_url) {
        return reply.status(400).send({ error: 'Validation Error', message: 'The webhook provider needs a webhook_url' });
      }
    }
    if (input.data.captcha) {
      next.captcha = { ...DEFAULT_AUTH_CONFIG.captcha, ...current.captcha, ...input.data.captcha };
      if (input.data.captcha.secret === MASK) next.captcha.secret = current.captcha?.secret ?? '';
      if (next.captcha.enabled && !next.captcha.secret) {
        return reply.status(400).send({ error: 'Validation Error', message: 'CAPTCHA needs the provider secret key' });
      }
    }
    // secrets are stored sealed by the vault (docs/vault.md); the auth service asks the vault for them
    await sealAuthSettings(id, next);
    await db`
      UPDATE control_plane.projects SET settings = jsonb_set(settings, '{auth}', ${db.json(next)}) WHERE id = ${id}`;
    await invalidateProjectCache(id);
    await audit(request, 'project.auth_config_updated', { type: 'project', id, projectId: id });
    return reply.send(redactAuthConfig(next));
  });

  server.get('/:id/audit-logs', { ...auth, schema: { ...tags, summary: 'Project audit logs' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const { limit = '100' } = request.query as { limit?: string };
    const rows = await db`
      SELECT a.id, a.timestamp, a.event_type, a.actor_id, pu.email AS actor_email, a.target_type, a.target_id, a.ip_address, a.metadata
      FROM control_plane.audit_logs a LEFT JOIN control_plane.platform_users pu ON pu.id = a.actor_id
      WHERE a.project_id = ${id}
      ORDER BY a.timestamp DESC LIMIT ${Math.min(Number(limit) || 100, 500)}`;
    return reply.send({ data: rows });
  });
};
