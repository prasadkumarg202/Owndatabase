#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OwnDatabase — point-in-time restore with pgBackRest  (UNTESTED TEMPLATE)
#
# Restores the WHOLE cluster (every project) to a timestamp. Per-project
# restores use the backup-worker instead (dashboard → Backups → Restore).
#
# Prerequisites (see docs/backups.md):
#   * infrastructure/pgbackrest/docker-compose.backup.yml is running
#   * archive_mode=on and archive_command='pgbackrest --stanza=owndatabase archive-push %p'
#   * at least one full backup:  pgbackrest --stanza=owndatabase backup --type=full
#
# Usage: scripts/pitr-restore.sh "2026-09-27 14:30:00+00"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
TARGET="${1:?usage: $0 \"YYYY-MM-DD HH:MM:SS+TZ\"}"
COMPOSE="docker compose -f docker-compose.yml -f infrastructure/pgbackrest/docker-compose.backup.yml"

echo "This will STOP PostgreSQL and replace its data directory with the state at: $TARGET"
read -r -p "Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "Aborted."; exit 1; }

echo "→ Checking the repository"
$COMPOSE exec -T pgbackrest pgbackrest --stanza=owndatabase info

echo "→ Stopping services that write to the database"
$COMPOSE stop control-api auth-service api-service realtime-service storage-api queue-worker cron-scheduler backup-worker pgbouncer
$COMPOSE stop postgres

echo "→ Restoring (delta) to $TARGET"
$COMPOSE run --rm --no-deps \
  -v owndatabase_postgres_data:/var/lib/postgresql/data \
  pgbackrest pgbackrest --stanza=owndatabase --delta \
  --type=time "--target=$TARGET" --target-action=promote restore

echo "→ Starting PostgreSQL (it replays WAL up to the target, then promotes)"
$COMPOSE start postgres
until $COMPOSE exec -T postgres pg_isready -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; do sleep 2; done

echo "→ Starting the platform"
$COMPOSE start pgbouncer control-api auth-service api-service realtime-service storage-api queue-worker cron-scheduler backup-worker
echo "✓ Restored to $TARGET. Take a fresh full backup now: $COMPOSE exec pgbackrest pgbackrest --stanza=owndatabase backup --type=full"
