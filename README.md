# OwnDatabase

> **Self-hosted PostgreSQL-first Backend-as-a-Service Platform**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What is OwnDatabase?

OwnDatabase is an open-source, self-hosted Backend-as-a-Service platform built on PostgreSQL.

**In one sentence:** Everything Supabase/Firebase does, but running on your own VPS at a fraction of the cost, with full PostgreSQL access and no vendor lock-in.

### Features

| Feature | Status | Where |
|---|---|---|
| Multi-project PostgreSQL (schema + owner role per project) | ✅ | Phase 1 |
| Dashboard (projects, table editor, SQL editor, auth, storage, realtime, functions, queues, cron, backups, logs, reports) | ✅ | Phase 0–9 |
| SQL editor, EXPLAIN, query history, extensions, roles, RLS policies | ✅ | Phase 1 |
| Auth: email/password, verification, refresh rotation, sessions, reset, OTP, OAuth (Google/GitHub + PKCE), TOTP MFA, lockout | ✅ | Phase 2 |
| Auto-generated REST API (filters, embedding, pagination, upsert, RPC, OpenAPI) with RLS | ✅ | Phase 3 |
| Storage: buckets, uploads, signed URLs, public/private, size + MIME limits, image transforms (S3 or local disk) | ✅ | Phase 4 |
| Realtime: table changes (RLS-aware), broadcast, presence | ✅ | Phase 5 |
| Monitoring (Prometheus, Grafana, Loki, alerts) + logs/usage/health in the dashboard | ✅ | Phase 6 |
| Per-project encrypted backups, verified by test restore; scheduled; restore | ✅ | Phase 7 |
| Cluster PITR with pgBackRest | ⚠️ untested template | Phase 7 |
| Functions (HTTP + queued), BullMQ jobs, cron, dead-letter queue, webhooks | ✅ | Phase 8 |
| CLI (`odb`) and MCP server | ✅ | Phase 9 |
| HA: Patroni + etcd + HAProxy | ⚠️ untested template | Phase 10 |

✅ = implemented and covered by the test suite in [`tests/`](tests/). ⚠️ = config written, never run. See [docs/implementation-plan.md](docs/implementation-plan.md) for the item-by-item list.

### Honest limitations

- **Projects share one PostgreSQL database.** Table data is isolated by schema, owner role and RLS, but a project's SQL editor can still read catalog metadata (e.g. names of other schemas) — normal PostgreSQL behaviour. Give a customer their own server if that matters.
- **Extensions are database-wide.** Enabling one (from the allowlist) enables it for every project.
- **Functions are not a security sandbox.** They run in a Node child process with a timeout, a memory cap and Node's permission model (no file writes, no child processes). Only deploy code you trust.
- **Realtime uses triggers + `LISTEN/NOTIFY`**, not logical replication. Rows bigger than ~8 KB are sent as a reference and re-read.

---

## Quick Start (Local Development)

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/) V2
- `make` (Linux/Mac) or [Git Bash](https://gitforwindows.org/) (Windows)
- `openssl` for generating secrets

### 1. Clone and configure

```bash
git clone https://github.com/your-org/owndatabase.git
cd owndatabase

# Copy environment template
cp .env.example .env
```

### 2. Generate secrets

```bash
make generate-secrets
```

Copy the output into your `.env` file, replacing the placeholder values.

### 3. Start all services

```bash
make up
```

Wait about 30-60 seconds for all services to initialize.

### 4. Verify

```bash
make ps
```

All services should show as `healthy`.

### 5. Open dashboard

Open your browser: **http://localhost**

---

## Service URLs (Local Development)

| Service | URL |
|---|---|
| Dashboard | http://localhost |
| Control API | http://localhost/api |
| API Docs (Swagger) | http://localhost/api/docs |
| Auth Service | http://localhost/auth |
| REST API | http://localhost/rest |
| Storage API | http://localhost/storage |
| Realtime | ws://localhost/realtime |
| Grafana | http://localhost/grafana |

---

## Architecture

```
Internet → Cloudflare → Caddy (reverse proxy)
                           │
              ┌────────────┴────────────┐
              │       CONTROL PLANE     │
              │  Dashboard (Next.js)    │
              │  Control API (Fastify)  │
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              │        DATA PLANE       │
              │  PostgreSQL + PgBouncer │
              │  Auth Service           │
              │  REST API               │
              │  Realtime (WebSocket)   │
              │  Storage API + S3       │
              │  Redis                  │
              └─────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for full architecture documentation.

---

## Development Commands

```bash
make up              # Start all services (migrations run automatically on control-api start)
make down            # Stop all services
make logs            # Stream all logs
make ps              # Show service status

make migrate         # Apply pending migrations by hand
make migrate-status  # Show which migrations are applied
make backup          # Full-database pg_dump to ./backups
make restore FILE=.  # Restore a full-database dump

make shell-api       # Shell in API container
make shell-db        # psql session
make shell-redis     # redis-cli session

make test-deps       # pip install test deps + Playwright Chromium
make test            # pytest API suite (stack must be running)
make test-e2e        # Playwright dashboard tests
make test-all        # both

make sync-shared     # copy platform/shared/*.ts into each service after editing it
make generate-secrets  # Generate random secrets
make reset             # DANGER: Remove all data
```

## Running the tests

The suite in `tests/` talks to a running stack over HTTP/WebSocket — it does not mock anything.

```bash
cp .env.example .env         # fill the secrets with: make generate-secrets
# For the full suite also set, in .env:
#   AUTH_DEV_MAILBOX=true      (lets tests read verification / reset emails)
#   LOGIN_RATE_LIMIT_MAX=1000  (the suite logs in many times from one IP; default is 10)
# On Docker Desktop (Windows/macOS) also set:
#   NODE_EXPORTER_ROOT_PROPAGATION=   (empty — Docker Desktop rejects "rslave")
make up
make test-deps
make test-all
```

By default tests go through the Caddy gateway at `http://localhost`. To point them elsewhere set `ODB_BASE_URL`, or per-service `ODB_API_URL`, `ODB_AUTH_URL`, `ODB_REST_URL`, `ODB_STORAGE_URL`, `ODB_REALTIME_URL`, `ODB_FUNCTIONS_URL`, `ODB_DASHBOARD_URL`.

A few tests need something extra and **skip** (not fail) without it. `.env.example` has the exact values, commented out:

| Test | Needs |
|---|---|
| email verification / reset / OTP | `AUTH_DEV_MAILBOX=true` |
| OAuth login flow | `OAUTH_GITHUB_*_URL` pointing at the mock provider the test starts on port 9911 (authorize URL via `localhost`, token/user URLs via `host.docker.internal` on Docker Desktop) |
| webhook delivery | `WEBHOOK_ALLOW_PRIVATE=true` and `ODB_WEBHOOK_HOST` = an address the queue-worker can reach (`host.docker.internal` on Docker Desktop) |
| CLI and MCP server | `npm install` in `platform/cli` and `platform/mcp-server` |

Service `/metrics` endpoints are internal-only (not routed by Caddy); the observability tests check them through Prometheus via `GET /api/observability/metrics`.

**Windows without `make`:** the targets are thin wrappers, so run them directly — load `.env` into the shell (Git Bash: `set -a; . ./.env; set +a`), then `docker compose up -d --build`, `pip install -r tests/requirements.txt && python -m playwright install chromium`, and `python -m pytest tests`. After pulling dependency changes use `--build` (or `make build`): `up -d` alone reuses old images.

Playwright screenshots are saved in `tests/e2e/screenshots/`.

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | PostgreSQL superuser password |
| `REDIS_PASSWORD` | ✅ | Redis password |
| `JWT_SECRET` | ✅ | JWT signing secret (min 32 chars) |
| `SECRET_ENCRYPTION_KEY` | ✅ | AES-256 key for secrets (hex, 64 chars) |
| `GRAFANA_PASSWORD` | ✅ | Grafana admin password |
| `MINIO_ROOT_PASSWORD` | ✅ | Bundled S3 (SeaweedFS) secret key |
| `DOMAIN` | | Your domain (default: localhost) |
| `GOOGLE_CLIENT_ID` | | Google OAuth |
| `GITHUB_CLIENT_ID` | | GitHub OAuth |
| `SMTP_HOST` | | SMTP for emails |

---

## Technology Stack

| Component | Technology |
|---|---|
| Database | PostgreSQL 16 |
| Connection pooling | PgBouncer |
| Cache + Queue | Redis 7 |
| Reverse proxy | Caddy |
| Control API | Fastify + TypeScript |
| Dashboard | Next.js 14 + Tailwind CSS |
| Object storage | SeaweedFS S3 (bundled) / any S3-compatible service / local disk |
| Monitoring | Prometheus + Grafana |
| Logging | Loki + Promtail |
| Containers | Docker + Docker Compose |

---

## Documentation

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Backups & restore](docs/backups.md)
- [High availability](docs/ha.md)
- [Database Schema](platform/migrations/)

---

## Contributing

This is an early-stage project. Contributions welcome!

See [docs/implementation-plan.md](docs/implementation-plan.md) for what needs to be built next.

---

## License

MIT License — see [LICENSE](LICENSE) file.

---

## Competitive Positioning

| Feature | OwnDatabase | Supabase | Firebase | Appwrite |
|---|---|---|---|---|
| Self-hosted | ✅ | ✅ (limited) | ❌ | ✅ |
| VPS-first | ✅ | ❌ | ❌ | ✅ |
| PostgreSQL access | ✅ Full | ✅ Full | ❌ | ❌ |
| Provider neutral | ✅ | ❌ | ❌ | Partial |
| Open source | ✅ | Partial | ❌ | ✅ |
| PostGIS | ✅ | ✅ | ❌ | ❌ |
| Low cost | ✅ | Partial | ❌ | ✅ |
| MCP Server | ✅ (planned) | ❌ | ❌ | ❌ |
