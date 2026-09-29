# High availability (Phase 10)

OwnDatabase can run on a 3-node PostgreSQL cluster managed by Patroni, with
automatic failover. This has been run end-to-end: the whole test suite passes
with the app on the cluster, and `tests/test_phase10_ha.py` crashes the primary
(SIGKILL) and checks that no acknowledged write is lost.

## What is provided

| File | Purpose |
|---|---|
| `infrastructure/ha/docker-compose.ha.yml` | 3 × etcd (DCS), 3 × Patroni/Spilo PostgreSQL 16, HAProxy, S3 store for WAL-G backups |
| `infrastructure/ha/haproxy.cfg` | Operator access: `:5000` → current primary, `:5001` → healthy replicas (lag ≤ 10 MB), `:7000` stats (bound to 127.0.0.1) |
| `infrastructure/ha/docker-compose.ha-app.yml` | Runs the app on the cluster (override for the main `docker-compose.yml`) |
| `infrastructure/ha/haproxy-app.cfg` | The `postgres` service in HA mode: routes `postgres:5432` to the current primary |
| `infrastructure/ha/prometheus-patroni.yml` | Prometheus job scraping Patroni on every node |

Patroni exposes a REST API on `:8008`. `GET /primary` returns 200 only on the
leader and `GET /replica` only on a healthy streaming replica, so HAProxy's
health checks follow a failover automatically.

## Running it

```bash
# .env: PATRONI_REPLICATION_PASSWORD, PATRONI_ADMIN_PASSWORD, HA_BACKUP_ENCRYPTION_KEY
#       (openssl rand -hex 24 / 24 / 32)
docker compose -p odb-ha --env-file .env -f infrastructure/ha/docker-compose.ha.yml up -d
docker compose -f docker-compose.yml -f infrastructure/ha/docker-compose.ha-app.yml up -d --build

# back to single-node (its data volume is untouched while in HA mode)
docker compose up -d --build --remove-orphans
docker compose -p odb-ha --env-file .env -f infrastructure/ha/docker-compose.ha.yml stop
```

In HA mode:

- `postgres` is an HAProxy on both networks that always routes to the current
  primary, so no service needs different settings. On failover it closes
  sessions to the old primary; PgBouncer and realtime's `LISTEN` reconnect.
- `ha-init` creates the database, extensions and API roles on the cluster (the
  single node does this from `docker-entrypoint-initdb.d`); control-api then
  runs the migrations as usual.
- The single-node pgBackRest sidecar is disabled — backups are made by WAL-G
  (below).

## Failover behaviour (measured)

- `synchronous_mode: true`: one replica is a **Sync Standby**, and a commit is
  acknowledged only once it has the WAL. A crash of the primary loses no
  acknowledged transaction (asserted by the failover test).
- Detection: Patroni's leader key has a 30 s TTL. After a hard crash (SIGKILL)
  writes through the app resumed after **31–36 s** in testing. A clean shutdown
  or `patronictl switchover` releases the key and is much faster.
- The crashed node rejoins as a replica of the new primary (`use_pg_rewind`).
- A rolling image upgrade (one node at a time) also works; the cluster stays
  available apart from one leader change.

## Backups (WAL-G)

Every node has WAL-G configured (Spilo): WAL is archived continuously
(`archive_timeout` 60 s) and a base backup is taken on `HA_BACKUP_SCHEDULE`
(default `0 1 * * *`, keep `HA_BACKUP_NUM_TO_RETAIN` = 5), encrypted with
libsodium (`HA_BACKUP_ENCRYPTION_KEY`). Only the current primary archives.

The bundled `backup-s3` (SeaweedFS) is on the same host, for rehearsal. For real
disaster recovery point `HA_BACKUP_S3_PREFIX`, `HA_BACKUP_S3_ENDPOINT`,
`HA_BACKUP_WALE_S3_ENDPOINT`, `HA_BACKUP_S3_ACCESS_KEY` and
`HA_BACKUP_S3_SECRET_KEY` at an off-site bucket.

```bash
# list backups / take one now (on the leader)
docker exec -u postgres odb-ha-pg1-1 envdir /run/etc/wal-e.d/env wal-g backup-list
docker exec -u postgres odb-ha-pg1-1 envdir /run/etc/wal-e.d/env /scripts/postgres_backup.sh /home/postgres/pgdata/pgroot/data
```

Point-in-time recovery in HA mode means bootstrapping a new cluster from the
bucket with Spilo's clone settings (`CLONE_METHOD=CLONE_WITH_WALE`,
`CLONE_WALG_S3_PREFIX`, `CLONE_TARGET_TIME`). That path is **not** covered by the
tests; `GET /api/cluster/backups` reports pgBackRest only, so in HA mode it shows
`configured: false` (its WAL archiver counters still work).

## Monitoring

Prometheus scrapes `pgN:8008/metrics` (Patroni ≥ 3.3.3 — 3.3.2 emits invalid
metrics on replicas). Alerts in `infrastructure/prometheus/rules/alerts.yml`:

| Alert | When |
|---|---|
| `PatroniNoLeader` (critical) | no member is primary for 1 min |
| `PatroniMemberDown` | a node is down or not scraped for 2 min |
| `PatroniReplicationLag` | a replica is > 16 MB behind for 5 min |
| `PatroniNoSyncStandby` | synchronous mode has no sync replica for 5 min |
| `PatroniFailover` (info) | the timeline changed in the last 15 min |

`patronictl list` on any node shows the current roles, timelines and lag.

## Security notes

- Spilo's default `pg_hba` requires SSL; the app does not use SSL inside
  Docker, so the cluster uses the single-node policy instead: scram passwords
  from private networks only, everything else rejected.
- Spilo preloads `pgextwlist`, which lets *any* role create about 20
  extensions (including `postgres_fdw`). It is disabled
  (`extwlist.extensions: ""`) so that the platform's `ALLOWED_EXTENSIONS` stays
  the only way a project gets an extension — found by the SQL-confinement test.
- None of the cluster ports should be reachable from the internet.

## Known gaps

- Reads are not routed to replicas by the app; `:5001` is for failover
  capacity and manual read-only/analytics connections.
- `synchronous_mode` costs a little write latency. With only two data nodes,
  turn it off or writes stop while one node is down.
- **Multi-VPS**: tested only as three containers on one host. For production put
  each `pgN` and `etcdN` on its own server (etcd on an odd number of hosts),
  replace the service names with private IPs/DNS, keep everything on a private
  network (WireGuard or the provider's VPC), and use an off-site backup bucket.
  The `postgres` router (HAProxy) then runs next to the app.
