#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OwnDatabase — point-in-time restore of the WHOLE cluster with pgBackRest
#
# Restores every project to the state at a timestamp. Everything written after
# it is discarded. Per-project restores use the backup-worker instead
# (dashboard → Backups → Restore).
#
# The restorable range is shown by GET /api/cluster/backups (pitr_window) or:
#   docker compose exec pgbackrest pgbackrest --stanza=owndatabase info
#
# Usage: scripts/pitr-restore.sh [--yes] "2026-09-27 14:30:00+00"
#        (run from the repository root; --yes skips the confirmation prompt)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

YES=0
if [ "${1:-}" = "--yes" ]; then YES=1; shift; fi
TARGET="${1:?usage: $0 [--yes] \"YYYY-MM-DD HH:MM:SS+TZ\"}"
COMPOSE="docker compose"
WRITERS="control-api auth-service api-service realtime-service storage-api queue-worker cron-scheduler backup-worker pgbouncer"

echo "This will STOP PostgreSQL and replace the whole cluster with its state at: $TARGET"
if [ $YES != 1 ]; then
  read -r -p "Type 'restore' to continue: " ok
  [ "$ok" = "restore" ] || { echo "Aborted."; exit 1; }
fi

echo "→ Archiving the current WAL so the newest changes are restorable"
# check forces a WAL switch and waits until the segment is in the repository
$COMPOSE exec -T pgbackrest pgbackrest --stanza=owndatabase check

echo "→ Stopping services that write to the database"
$COMPOSE stop $WRITERS pgbackrest
$COMPOSE stop postgres

echo "→ Restoring (delta) to $TARGET"
$COMPOSE run --rm --no-deps -T --entrypoint pgbackrest pgbackrest \
  --stanza=owndatabase --delta --type=time "--target=$TARGET" --target-action=promote restore

echo "→ Starting PostgreSQL (it replays WAL up to the target, then promotes)"
$COMPOSE start postgres
until [ "$($COMPOSE exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -XAtq -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select not pg_is_in_recovery()"' 2>/dev/null | tr -d '\r')" = "t" ]; do
  sleep 2
done

echo "→ Starting the platform"
$COMPOSE start $WRITERS pgbackrest

echo "✓ Restored to $TARGET. The cluster is on a new WAL timeline; the pgbackrest"
echo "  sidecar keeps backing it up on its normal schedule."
