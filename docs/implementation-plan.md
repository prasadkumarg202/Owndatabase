# OwnDatabase — Implementation Plan

> Status legend: `[x]` implemented — application features are covered by the pytest/Playwright suite in `tests/`; the full stack, including Caddy, Prometheus (every service scraped, node-exporter included) and Grafana (health and provisioned datasources), was brought up with Docker Compose and checked by the suite (142 tests passing, 0 skipped with the test settings from `.env.example`). Loki is running but its log contents are not asserted. `[~]` partial or untested template. `[ ]` not done.

> **Version:** 0.1.0

---

## Phase 0 — Local Development Environment

**Goal:** A complete, runnable Docker Compose stack for local development.

**Success criteria:** `make up` brings up all services; developer can connect to dashboard.

### Deliverables

- [x] `docker-compose.yml` with all core services
- [x] `.env.example` with all required variables
- [x] `Makefile` with standard commands
- [x] `README.md` with setup instructions
- [x] PostgreSQL initialized with control plane schema
- [x] PgBouncer configured and connected
- [x] Redis running
- [x] Caddy reverse proxy routing all services
- [x] Prometheus + Grafana accessible
- [x] Loki log aggregation
- [x] S3 object storage (SeaweedFS in compose; service is still named `minio`)
- [x] Control API (basic health endpoint)
- [x] Dashboard skeleton (Next.js, login page)
- [x] All services communicate on internal network
- [x] No internal ports exposed to host (only Caddy 80/443)

**Services:**

| Service | Image | Role |
|---|---|---|
| postgres | postgres:16-alpine | Primary database |
| pgbouncer | edoburu/pgbouncer | Connection pooling |
| redis | redis:7-alpine | Cache + queue |
| caddy | caddy:2-alpine | Reverse proxy + TLS |
| control-api | custom | Control plane API |
| dashboard | custom | Next.js dashboard |
| auth-service | custom | Authentication |
| api-service | custom | Auto REST API |
| realtime-service | custom | WebSocket/WAL |
| storage-api | custom | File storage API |
| minio | minio/minio | Local object storage |
| prometheus | prom/prometheus | Metrics collection |
| grafana | grafana/grafana | Metrics dashboards |
| loki | grafana/loki | Log aggregation |
| promtail | grafana/promtail | Log shipping |

---

## Phase 1 — Database Platform

**Goal:** Working PostgreSQL management UI and SQL editor.

### Deliverables

- [x] Project creation (UI + API)
- [x] Database/schema creation per project
- [x] Table browser (list, view structure)
- [x] Table editor (create table, add column, add index)
- [x] SQL editor (execute, results, history)
- [x] EXPLAIN / EXPLAIN ANALYZE
- [x] Database statistics (size, connections, slow queries)
- [x] Extension management (PostGIS, pgvector, etc.)
- [x] Database role management
- [x] RLS policy editor

---

## Phase 2 — Authentication Platform

**Goal:** Complete auth system usable by applications.

### Deliverables

- [x] User signup (email/password)
- [x] Email verification
- [x] Login + JWT issuance
- [x] Refresh token rotation
- [x] Session management
- [x] Password reset (magic link)
- [x] Logout (single + all devices)
- [x] OAuth (Google, GitHub)
- [x] MFA/TOTP
- [x] Phone auth: SMS OTP, phone + password, phone change (Twilio / signed webhook) — see [phone-auth.md](phone-auth.md)
- [x] Auth dashboard (users, sessions)
- [x] Auth configuration per project
- [x] Rate limiting + brute force protection (per-email lockout, 429 + Retry-After)

---

## Phase 3 — REST API

**Goal:** Automatic REST API from PostgreSQL schema.

### Deliverables

- [x] Auto-generate endpoints from tables
- [x] GET, POST, PATCH, DELETE
- [x] Filtering (eq, neq, gt, lt, like, ilike, in)
- [x] Sorting
- [x] Pagination (offset + cursor-based)
- [x] Field selection
- [x] Count endpoint
- [x] Relationships (foreign key traversal)
- [x] RLS integration (JWT → PostgreSQL role)
- [x] OpenAPI spec auto-generation
- [x] API key authentication
- [x] Rate limiting

---

## Phase 4 — Storage

**Goal:** File storage with S3-compatible backend.

### Deliverables

- [x] Bucket management
- [x] File upload
- [x] File download
- [x] File delete
- [x] Signed URLs (time-limited)
- [x] Public/private buckets
- [x] File size limits
- [x] MIME type restrictions
- [x] Storage metadata in PostgreSQL
- [x] MinIO local + S3/R2/B2 production support
- [x] Image transformation (resize, compress, WebP)

---

## Phase 5 — Realtime

**Goal:** WebSocket-based database change subscriptions.

### Deliverables

- [x] WebSocket endpoint
- [x] Change detection — **trigger + LISTEN/NOTIFY**, not logical WAL decoding (large rows are sent by reference)
- [x] Per-table subscriptions
- [x] Channel-based pub/sub (broadcast)
- [x] Presence
- [x] Auth integration (JWT validation per subscription)
- [x] RLS-aware filtering

---

## Phase 6 — Observability

**Goal:** Complete monitoring, logging, alerting.

### Deliverables

- [x] Prometheus metrics for all services
- [x] Grafana dashboards (API, DB, Auth, Storage, Realtime, System)
- [x] Loki log aggregation
- [x] Alert rules (CPU, RAM, disk, connections, replication lag, backup failure)
- [x] Dashboard alerts page
- [x] Slow query detection
- [x] Connection pool monitoring
- [x] Vacuum/autovacuum monitoring

---

## Phase 7 — Backup & Restore

**Goal:** Automated backups with PITR and restore capability.

### Deliverables

- [x] pgBackRest integration — `pgbackrest` sidecar in the main stack: stanza, scheduled full/diff/incr backups, encrypted repository; status at `GET /api/cluster/backups`
- [x] Full backups per project (pg_dump); cluster-wide full/diff/incremental via pgBackRest
- [x] WAL archiving — `archive_command` = pgBackRest `archive-push`, `archive_timeout` 60s, Prometheus alerts on failure/staleness
- [x] Backup encryption
- [x] Backup scheduling
- [x] Restore via dashboard
- [x] PITR restore — `scripts/pitr-restore.sh` restores the whole cluster to a timestamp (round-trip tested with `ODB_DESTRUCTIVE_TESTS=1`); the dashboard restore is per-project, to a backup
- [x] Backup verification (automated restore tests)
- [x] Backup status dashboard
- [x] Retention policy

---

## Phase 8 — Functions & Queues

**Goal:** Serverless-style functions and job queues.

### Deliverables

- [x] Function definitions and isolation. Functions run in a separate runtime container with no access to the platform network. Each project gets its own uid, and a firewall blocks private and internal addresses. The Node permission model, heap limits and timeouts also apply. See [functions.md](functions.md).
- [x] Function deployment
- [x] Function logs
- [x] BullMQ queue abstraction
- [x] Cron scheduler
- [x] Dead-letter queue
- [x] Queue dashboard

---

## Phase 9 — CLI & MCP

**Goal:** CLI and MCP server for AI agent integration.

### Deliverables

- [x] Platform CLI (login, projects, db, logs, functions, secrets, storage)
- [x] MCP server (list_projects, get_project, run_sql, list_tables, etc.)
- [x] OpenAPI documentation
- [x] Schema introspection API

---

## Phase 10 — HA & Scaling

**Goal:** Production HA with automatic failover.

### Deliverables

> See [docs/ha.md](ha.md). Tested with `ODB_HA=1` (`tests/test_phase10_ha.py`, plus the whole suite on the cluster).

- [x] Patroni for PostgreSQL HA — 3 nodes + etcd, synchronous mode (no acknowledged write lost on crash)
- [x] HAProxy for connection routing — the app's `postgres` follows the primary; `:5001` for replicas
- [x] Read replica configuration — 2 streaming replicas; the app does not route reads to them yet
- [x] Automatic failover — primary SIGKILL → writes resume in ~31–36 s, old node rejoins via pg_rewind
- [x] Replication monitoring — Patroni metrics in Prometheus + 5 alert rules
- [x] HA backups — WAL-G continuous archiving + scheduled encrypted base backups to S3
- [~] Multi-VPS deployment support — documented, tested only on one host

---

## MVP Success Criteria Checklist

| # | Criteria | Phase |
|---|---|---|
| 1 | Install on VPS | 0 |
| 2 | Open dashboard | 0 |
| 3 | Create project | 1 |
| 4 | Create PostgreSQL database | 1 |
| 5 | Create table | 1 |
| 6 | Create user | 2 |
| 7 | Login via API | 2 |
| 8 | Query table via REST API | 3 |
| 9 | Upload image | 4 |
| 10 | Subscribe to realtime | 5 |
| 11 | Create API key | 3 |
| 12 | Run SQL | 1 |
| 13 | Create backup | 7 |
| 14 | Restore backup | 7 |
| 15 | View logs | 6 |
| 16 | View metrics | 6 |
