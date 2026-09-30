# Backups and restore (Phase 7)

OwnDatabase has two layers of backup. Both run by default and are covered by
the test suite (`tests/test_phase7_backups.py`, `tests/test_phase7_pitr.py`).

## 1. Per-project logical backups (implemented, tested)

Handled by `backup-worker`, triggered from the dashboard (**Backups → Create
backup**), the API (`POST /api/backups` with `{"project_id": ...}`), the CLI
(`odb backups create`) or on a schedule (`backup_configs.full_backup_cron`,
queued by `cron-scheduler`).

Each backup:

1. runs `pg_dump -Fc -n project_<slug>`;
2. is encrypted with AES-256-GCM using `BACKUP_ENCRYPTION_KEY` (its own key, required;
   older backups are restored with any key in `BACKUP_DECRYPT_KEYS`);
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

## 2. Cluster-wide physical backups + point-in-time recovery (pgBackRest)

Covers **everything** in PostgreSQL — every project schema, `auth`, `storage`
metadata and the control plane.

**How it runs**

- The `postgres` image (`infrastructure/postgres/Dockerfile`) includes pgBackRest.
  `archive_command = 'pgbackrest --stanza=owndatabase archive-push %p'`, with
  `archive_timeout = 60`, so at most about a minute of writes is not yet archived.
- The `pgbackrest` sidecar shares the data volume, the Unix socket and the
  repository volume (`owndatabase_pgbackrest_repo`) with `postgres`. On start it
  creates the stanza, checks that archiving works, and takes a full backup if
  there is none. Every 5 minutes it takes a **full** backup when the newest one is
  older than `PGBACKREST_FULL_HOURS` (168), else a **diff** after
  `PGBACKREST_DIFF_HOURS` (24), else an **incr** after `PGBACKREST_INCR_HOURS` (1).
  The decision is made from the repository itself, so restarts never skip or
  duplicate a backup.
- The repository is encrypted (AES-256-CBC) with `PGBACKREST_CIPHER_PASS`, and
  compressed with lz4. Retention: 4 full backups and 7 diffs, with their WAL.

> Keep `PGBACKREST_CIPHER_PASS` somewhere other than this server, and never
> change it for an existing repository — the backups would become unreadable.

**Status**

- `GET /api/cluster/backups` (platform admins only) returns the backups, the
  restorable window (`pitr_window.from` → `pitr_window.to`), and live WAL
  archiver counters. The sidecar refreshes it after every backup.
- `docker compose exec pgbackrest pgbackrest --stanza=owndatabase info`
- Prometheus alerts: `WALArchivingFailing` (critical) and `WALArchivingStale`.
  The sidecar's container health turns unhealthy when a backup fails.

**Point-in-time restore of the whole cluster**

```bash
scripts/pitr-restore.sh "2026-09-27 14:30:00+00"      # asks for confirmation
scripts/pitr-restore.sh --yes "2026-09-27 14:30:00+00" # for automation
```

The script archives the current WAL, stops every service that writes to the
database, restores with `--delta` to the target time, lets PostgreSQL replay WAL
up to it and promote, then starts everything again. The cluster continues on a
new WAL timeline, which the sidecar keeps backing up. Everything written after
the target time is discarded — for every project.

`test_point_in_time_restore` does this round-trip (write → note the time → write
again → restore → only the first write remains). Because it rolls the whole
cluster back, it runs only with `ODB_DESTRUCTIVE_TESTS=1`.

**Off-site copies**

The repository is a Docker volume on the same host. For disaster recovery, add
a second repository on S3-compatible storage in
`infrastructure/pgbackrest/pgbackrest.conf` (`repo2-type=s3`, `repo2-s3-*`, with
its own `repo2-cipher-pass`); pgBackRest then archives and backs up to both.

A per-project restore request with `target_time` is rejected with a message
pointing here, because a logical dump cannot be rolled to an arbitrary time.
