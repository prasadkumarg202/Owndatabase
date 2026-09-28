/**
 * Backup Routes (Phase 7)
 *
 * GET   /api/backups?project_id=...            — List backups
 * POST  /api/backups                           — Queue a manual backup
 * GET   /api/backups/:id                       — Backup details
 * GET   /api/backups/:id/status                — Backup status (lightweight)
 * POST  /api/backups/:id/restore               — Queue a restore (requires confirm: true)
 * GET   /api/backups/restores?project_id=...   — Restore history
 * GET   /api/backups/projects/:id/backup-config
 * PATCH /api/backups/projects/:id/backup-config
 *
 * The heavy lifting (pg_dump / pg_restore, encryption, verification,
 * retention) happens in the backup worker; this API only records intent
 * and enqueues jobs.
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { ADMIN_ROLES, audit, requireProject, userId } from '../lib/access.js';
import { backupQueue } from '../lib/queues.js';

const createBackupSchema = z.object({
  project_id: z.string().uuid(),
  type: z.enum(['full', 'differential', 'incremental']).default('full'),
});

const restoreSchema = z.object({
  target_time: z.string().datetime({ offset: true }).optional(),
  confirm: z.literal(true, { errorMap: () => ({ message: 'You must explicitly confirm restore by setting confirm: true' }) }),
});

const CRON_RE = /^(\S+\s+){4}\S+$/;

export const backupRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate] };
  const tags = { tags: ['backups'], security: [{ bearerAuth: [] }] };

  server.get('/', { ...auth, schema: { ...tags, summary: 'List backups for a project' } }, async (request, reply) => {
    const { project_id, limit = '20' } = request.query as { project_id?: string; limit?: string };
    const p = await requireProject(request, reply, project_id ?? '');
    if (!p) return;
    const backups = await db`
      SELECT id, type, status, size_bytes, duration_ms, storage_path, restore_point, is_encrypted, is_verified,
             verified_at, expires_at, error_message, metadata, created_at, updated_at
      FROM control_plane.backups
      WHERE project_id = ${p.id} AND status <> 'deleted'
      ORDER BY created_at DESC LIMIT ${Math.min(Number(limit) || 20, 100)}`;
    return reply.send({ data: backups.map((b) => ({ ...b, size_bytes: b['size_bytes'] === null ? null : Number(b['size_bytes']) })), count: backups.length });
  });

  server.post('/', { ...auth, schema: { ...tags, summary: 'Trigger a manual backup' } }, async (request, reply) => {
    const input = createBackupSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const { project_id, type } = input.data;
    const p = await requireProject(request, reply, project_id, ADMIN_ROLES);
    if (!p) return;

    const [backup] = await db`
      INSERT INTO control_plane.backups (project_id, type, status, is_encrypted, created_by, metadata)
      VALUES (${project_id}, ${type}, 'pending', true, ${userId(request)}, ${db.json({ trigger: 'manual', schema: p.db_schema })})
      RETURNING id, type, status, created_at`;
    await backupQueue().add('backup.run', { backupId: backup!['id'] }, { jobId: `backup-${backup!['id']}`, attempts: 2, removeOnComplete: 100 });
    await audit(request, 'backup.created', { type: 'backup', id: backup!['id'] as string, projectId: project_id }, { type });
    logger.info({ projectId: project_id, backupId: backup!['id'] }, 'Backup queued');
    return reply.status(202).send({ ...backup, message: `Backup queued. Poll GET /api/backups/${backup!['id']}` });
  });

  server.get('/restores', { ...auth, schema: { ...tags, summary: 'Restore history' } }, async (request, reply) => {
    const { project_id } = request.query as { project_id?: string };
    const p = await requireProject(request, reply, project_id ?? '');
    if (!p) return;
    const rows = await db`
      SELECT id, backup_id, status, target_time, error_message, started_at, finished_at, created_at
      FROM control_plane.restores WHERE project_id = ${p.id} ORDER BY created_at DESC LIMIT 50`;
    return reply.send({ data: rows });
  });

  async function loadBackup(request: any, reply: any, id: string, roles: any = null) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) { reply.status(404).send({ error: 'Not Found', message: 'Backup not found' }); return null; }
    const [backup] = await db`SELECT * FROM control_plane.backups WHERE id = ${id}`;
    if (!backup) { reply.status(404).send({ error: 'Not Found', message: 'Backup not found' }); return null; }
    const p = await requireProject(request, reply, backup['project_id'] as string, roles);
    if (!p) return null;
    return { backup, project: p };
  }

  server.get('/:id', { ...auth, schema: { ...tags, summary: 'Backup details' } }, async (request, reply) => {
    const r = await loadBackup(request, reply, (request.params as any).id);
    if (!r) return;
    return reply.send({ ...r.backup, size_bytes: r.backup['size_bytes'] === null ? null : Number(r.backup['size_bytes']) });
  });

  server.get('/:id/status', { ...auth, schema: { ...tags, summary: 'Backup status' } }, async (request, reply) => {
    const r = await loadBackup(request, reply, (request.params as any).id);
    if (!r) return;
    return reply.send({ id: r.backup['id'], status: r.backup['status'], is_verified: r.backup['is_verified'], error_message: r.backup['error_message'] });
  });

  server.post('/:id/restore', { ...auth, schema: { ...tags, summary: 'Restore a project from a backup' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = restoreSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Must confirm restore' });
    const r = await loadBackup(request, reply, id, ADMIN_ROLES);
    if (!r) return;
    if (!['completed', 'verified'].includes(r.backup['status'] as string)) {
      return reply.status(409).send({ error: 'Conflict', message: 'Cannot restore from a backup that is not completed or verified' });
    }
    const [running] = await db`SELECT id FROM control_plane.restores WHERE project_id = ${r.project.id} AND status IN ('pending','running')`;
    if (running) return reply.status(409).send({ error: 'Conflict', message: 'A restore is already in progress for this project' });

    const [restore] = await db`
      INSERT INTO control_plane.restores (backup_id, project_id, target_time, created_by)
      VALUES (${id}, ${r.project.id}, ${input.data.target_time ?? null}, ${userId(request)})
      RETURNING id, backup_id, status, created_at`;
    await backupQueue().add('restore.run', { restoreId: restore!['id'] }, { jobId: `restore-${restore!['id']}`, attempts: 1 });
    await audit(request, 'backup.restore_initiated', { type: 'backup', id, projectId: r.project.id }, { restore_id: restore!['id'], target_time: input.data.target_time });
    logger.warn({ backupId: id, projectId: r.project.id }, 'Restore queued');
    return reply.status(202).send({
      ...restore,
      restore_id: restore!['id'],
      message: 'Restore queued. The current schema is kept as a safety copy until the restore succeeds.',
      warning: 'This will replace the current project data with the backup contents.',
    });
  });

  server.get('/projects/:id/backup-config', { ...auth, schema: { ...tags, summary: 'Backup schedule' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id);
    if (!p) return;
    const [cfg] = await db`
      INSERT INTO control_plane.backup_configs (project_id) VALUES (${id})
      ON CONFLICT (project_id) DO UPDATE SET project_id = EXCLUDED.project_id
      RETURNING *`;
    return reply.send(cfg);
  });

  server.patch('/projects/:id/backup-config', { ...auth, schema: { ...tags, summary: 'Update backup schedule' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = await requireProject(request, reply, id, ADMIN_ROLES);
    if (!p) return;
    const input = z.object({
      full_cron: z.string().regex(CRON_RE, 'Invalid cron expression').optional(),
      diff_cron: z.string().regex(CRON_RE, 'Invalid cron expression').optional(),
      retention_days: z.number().int().min(1).max(3650).optional(),
      is_enabled: z.boolean().optional(),
    }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const b = input.data;
    const [cfg] = await db`
      INSERT INTO control_plane.backup_configs (project_id) VALUES (${id}) ON CONFLICT (project_id) DO NOTHING`.then(() => db`
      UPDATE control_plane.backup_configs SET
        full_backup_cron = COALESCE(${b.full_cron ?? null}, full_backup_cron),
        diff_backup_cron = COALESCE(${b.diff_cron ?? null}, diff_backup_cron),
        retention_days = COALESCE(${b.retention_days ?? null}, retention_days),
        is_enabled = COALESCE(${b.is_enabled ?? null}, is_enabled),
        updated_at = NOW()
      WHERE project_id = ${id} RETURNING *`);
    await audit(request, 'backup.config_updated', { type: 'project', id, projectId: id }, b);
    return reply.send(cfg);
  });
};
