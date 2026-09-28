# Backups and restore (Phase 7)

OwnDatabase has two layers of backup. Only the first is tested.

## 1. Per-project logical backups (implemented, tested)

Handled by `backup-worker`, triggered from the dashboard (**Backups → Create
backup**), the API (`POST /api/backups` with `{"project_id": ...}`), the CLI
(`odb backups create`) or on a schedule (`backup_configs.full_backup_cron`,
queued by `cron-scheduler`).

Each backup:

1. runs `pg_dump -Fc -n project_<slug>`;
2. is encrypted with AES-256-GCM using `BACKUP_ENCRYPTION_KEY`
   (falls back to `SECRET_ENCRYPTION_KEY`);
3. gets a SHA-256 checksum;
4. is verified: `pg_restore --list`, then a **test restore into a temporary
   database**, which is dropped afterwards.

**Restore** (dashboard or `POST /api/backups/:backupId/restore`) renames the live
schema to a safety copy, restores, re-applies ownership and grants, then drops
the safety copy — if the restore fails, the old schema is put back.

Retention: each backup expires after `backup_configs.retention_days` (default 30) and is deleted by
an hourly sweep.

> Keep a copy of `BACKUP_ENCRYPTION_KEY` somewhere other than this server.
> Without it, encrypted backups cannot be read.

What this layer does **not** cover: `auth.users`, storage objects metadata and
the control plane are shared tables, so they are not part of a project dump.
Use layer 2 (or a full `make backup`) for those.

## 2. Cluster-wide physical backups + PITR (untested template)

`infrastructure/pgbackrest/` contains a pgBackRest config (encrypted repo,
4 full / 7 diff retention) and a compose file. To enable it:

1. In `infrastructure/postgres/postgresql.conf` set
   ```
   archive_mode = on
   archive_command = 'pgbackrest --stanza=owndatabase archive-push %p'
   ```
   (pgBackRest must be installed in the postgres image for this — the stock
   `postgres:16` image does not include it.)
2. `docker compose -f docker-compose.yml -f infrastructure/pgbackrest/docker-compose.backup.yml up -d`
3. `... exec pgbackrest pgbackrest --stanza=owndatabase stanza-create`
4. `... exec pgbackrest pgbackrest --stanza=owndatabase backup --type=full`

Point-in-time restore of the whole cluster: `scripts/pitr-restore.sh "2026-09-27 14:30:00+00"`.

A per-project restore request with `target_time` is rejected with a message
pointing here, because a logical dump cannot be rolled to an arbitrary time.
