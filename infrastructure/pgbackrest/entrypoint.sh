#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# OwnDatabase — pgBackRest sidecar
#
# 1. waits for PostgreSQL, creates the stanza (idempotent) and checks that WAL
#    archiving reaches the repository
# 2. takes a full backup if there is none
# 3. every BACKUP_CHECK_MINUTES (5), takes a full / diff / incr backup when the
#    newest backup of that kind is older than its interval, then publishes
#    `pgbackrest info` to control_plane.cluster_backup_status for the API
#
# Intervals (hours): BACKUP_FULL_HOURS (168), BACKUP_DIFF_HOURS (24),
# BACKUP_INCR_HOURS (1) — set from PGBACKREST_*_HOURS in .env. Deciding from the repository itself (not cron)
# means a restart or downtime never skips or duplicates a backup.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

STANZA=owndatabase
FULL_H=${BACKUP_FULL_HOURS:-168}
DIFF_H=${BACKUP_DIFF_HOURS:-24}
INCR_H=${BACKUP_INCR_HOURS:-1}
CHECK_MIN=${BACKUP_CHECK_MINUTES:-5}
HEALTH=/tmp/pgbackrest-ok
PSQL="psql -X -q -v ON_ERROR_STOP=1 -h /var/run/postgresql -U ${PGUSER:-postgres} -d ${PGDATABASE:-owndatabase}"

trap 'exit 0' TERM INT

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

publish() {
  # $1 = last error ('' on success). psql only substitutes :'vars' in stdin/-f.
  info=$(pgbackrest --stanza=$STANZA --output=json info 2>/dev/null || echo '[]')
  $PSQL -v info="$info" -v err="$1" <<'SQL' || log "could not publish backup status"
INSERT INTO control_plane.cluster_backup_status (id, info, last_error, updated_at)
VALUES (1, (:'info')::jsonb -> 0, NULLIF(:'err', ''), now())
ON CONFLICT (id) DO UPDATE
  SET info = EXCLUDED.info, last_error = EXCLUDED.last_error, updated_at = EXCLUDED.updated_at;
SQL
}

# seconds since the newest backup whose type is in $1 (e.g. "full" or "full diff")
age_of() {
  pgbackrest --stanza=$STANZA --output=json info 2>/dev/null | jq -r --argjson types "$(printf '%s' "$1" | jq -R 'split(" ")')" '
    [.[0].backup[]? | select(.type as $t | $types | index($t)) | .timestamp.stop] | max // 0
    | (now - .) | floor'
}

backup() {
  log "starting $1 backup"
  if pgbackrest --stanza=$STANZA --type="$1" backup; then
    log "$1 backup finished"; publish ''
  else
    log "$1 backup FAILED"; publish "$1 backup failed at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"; return 1
  fi
}

log "waiting for PostgreSQL"
until pg_isready -q -h /var/run/postgresql; do sleep 2; done
until $PSQL -c "SELECT 1 FROM control_plane.cluster_backup_status LIMIT 0" >/dev/null 2>&1; do
  log "waiting for migrations (control_plane.cluster_backup_status)"; sleep 5
done

pgbackrest --stanza=$STANZA stanza-create
# check forces a WAL switch and waits until that segment is in the repository
until pgbackrest --stanza=$STANZA check; do log "archive check failed, retrying in 10s"; sleep 10; done

publish ''

while :; do
  ok=1
  full=$(age_of 'full'); diff=$(age_of 'full diff'); incr=$(age_of 'full diff incr')
  case "$full$diff$incr" in
    ''|*[!0-9]*) log "could not read the repository (pgbackrest info)"; ok=0 ;;
    *)
      if   [ "$full" -ge $((FULL_H * 3600)) ]; then backup full || ok=0
      elif [ "$diff" -ge $((DIFF_H * 3600)) ]; then backup diff || ok=0
      elif [ "$incr" -ge $((INCR_H * 3600)) ]; then backup incr || ok=0
      fi ;;
  esac
  [ $ok = 1 ] && touch $HEALTH
  sleep $((CHECK_MIN * 60)) &
  wait $!
done
