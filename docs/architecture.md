# OwnDatabase — Architecture

> **Version:** 0.1.0  
> **Status:** Active  
> **Last Updated:** 2026-09-24

---

## Overview

OwnDatabase is a production-oriented, self-hosted Backend-as-a-Service (BaaS) platform.  
It is PostgreSQL-first, VPS-first, cloud-provider-neutral and designed to run cheaply on
commodity hardware while scaling progressively to multi-server, multi-region deployments.

**Primary differentiators vs existing BaaS:**

| Property | OwnDatabase |
|---|---|
| Database | PostgreSQL — fully exposed, no abstraction |
| Deployment | VPS-first, Docker, provider-neutral |
| Cost | Minimum managed cloud dependencies |
| Portability | No vendor lock-in |
| AI-Friendly | MCP server, OpenAPI, CLI, schema introspection |
| Locality | PostGIS, geo-search, Indian app optimized |
| Backup | pgBackRest, PITR, encrypted, tested |

---

## Logical Architecture

The platform is divided into two completely separate logical planes.

```
Internet
   │
Cloudflare (DNS + CDN + WAF + TLS)
   │
Reverse Proxy (Caddy)
   │
   ├─── CONTROL PLANE
   │       Dashboard (Next.js)
   │       Control API (Node.js / TypeScript)
   │       Project Manager
   │       Server Manager
   │       Deployment Manager
   │       Backup Manager
   │       Monitoring Aggregator
   │
   └─── DATA PLANE (per project)
           API Gateway
           Auth Service
           PostgreSQL
           PgBouncer
           Realtime Service
           Storage API
           Functions Runner
           Queue Worker
           Cron Scheduler
           Redis / Cache
```

---

## Control Plane

**Responsibilities:**

- Organizations, projects, teams, users (platform-level)
- Server registration and lifecycle
- Database provisioning and credential management
- Service lifecycle (start, stop, restart, pause)
- API key management
- Secret management (encrypted at rest)
- Backup scheduling and orchestration
- Deployment pipelines
- Health checks and alerting
- Billing-ready metering

**Technology:**

- Runtime: Node.js / TypeScript
- Framework: Fastify
- Database: PostgreSQL (control plane schema, separate from project data)
- Auth: JWT + secure cookies
- API: REST + OpenAPI

---

## Data Plane

**Responsibilities:**

- Per-project PostgreSQL instance (or schema, depending on isolation mode)
- Connection pooling via PgBouncer
- REST API auto-generation
- Authentication and session management
- WebSocket/Realtime infrastructure
- File storage API (S3-compatible backend)
- Serverless function execution
- Job queue processing
- Scheduled cron jobs
- Redis cache

**Technology:**

- API Gateway: Caddy + lightweight custom router
- Database: PostgreSQL 16+
- Pooling: PgBouncer
- Auth: Custom service (Argon2id, PKCE, OAuth 2.1, OIDC)
- Realtime: Custom WebSocket service (WAL-based)
- Storage: S3-compatible abstraction
- Queue: Redis (BullMQ)
- Cache: Redis

---

## Deployment Layers

### Phase 0 — Local Development
Single Docker Compose stack, all services on one host.

### Phase 1 (Stage 1) — Single VPS
All services on one VPS. Suitable for development projects and small production.

```
VPS
├── Caddy (reverse proxy)
├── control-api
├── dashboard
├── postgres (primary)
├── pgbouncer
├── auth-service
├── api-service
├── realtime-service
├── storage-api
├── redis
├── prometheus
├── grafana
└── loki
```

### Phase 2 (Stage 2) — Two VPS
Separate application and database servers.

```
VPS 1: Application
├── Caddy
├── control-api
├── dashboard
├── auth-service
├── api-service
├── realtime-service
├── storage-api
├── redis
├── prometheus
└── grafana

VPS 2: Database
├── postgres (primary)
├── pgbouncer
└── pgbackrest
```

### Phase 3 (Stage 3) — Three VPS
Separate read replica.

```
VPS 1: Application
VPS 2: PostgreSQL Primary
VPS 3: PostgreSQL Replica (streaming replication)
```

### Phase 4 (Stage 4) — HA
Full high availability.

```
Load Balancer (HAProxy or cloud LB)
├── API Server 1
├── API Server 2
PostgreSQL Primary (Patroni)
PostgreSQL Replica 1
PostgreSQL Replica 2
Redis (Sentinel or Cluster)
Object Storage (S3-compatible)
Backup Server
```

### Phase 5 — Multi-Region
Advanced stage. Not targeted for MVP.

---

## Key Architectural Decisions

### ADR-001: PostgreSQL as Primary Database

**Problem:** What database engine to use?  
**Options:** PostgreSQL, MySQL, MongoDB, custom  
**Decision:** PostgreSQL  
**Reason:** Industry-proven, full SQL, JSONB, PostGIS, pgvector, RLS, streaming replication, PITR, extensions ecosystem.  
**Trade-offs:** More complex than SQLite for single-file deployments; more memory than MariaDB.

---

### ADR-002: No Custom Database Abstraction

**Problem:** Should we wrap PostgreSQL in a proprietary API that hides SQL?  
**Decision:** No.  
**Reason:** Developers should have full PostgreSQL access. Auto-generated REST API is an additional convenience layer, not a replacement. Hiding PostgreSQL reduces portability.  
**Trade-offs:** Users must understand basic SQL for advanced features.

---

### ADR-003: Docker Compose for MVP

**Problem:** What infrastructure tool for Phase 0 and Phase 1?  
**Options:** Kubernetes, Docker Swarm, Docker Compose, bare metal scripts  
**Decision:** Docker Compose  
**Reason:** Lowest complexity, widest VPS compatibility, easy to reason about, easy to debug.  
**Trade-offs:** Single-host only; Swarm/Kubernetes needed for multi-host scheduling.

---

### ADR-004: PgBouncer for Connection Pooling

**Problem:** PostgreSQL has expensive connection overhead.  
**Decision:** PgBouncer in transaction-pooling mode.  
**Reason:** Battle-tested, simple, minimal resource usage.  
**Trade-offs:** Does not support session-level features (SET, advisory locks) in transaction mode.

---

### ADR-005: Caddy as Reverse Proxy

**Problem:** Which reverse proxy?  
**Options:** Nginx, Traefik, Caddy, Envoy  
**Decision:** Caddy  
**Reason:** Automatic TLS, simple configuration, actively maintained, easy Docker integration.  
**Trade-offs:** Less ecosystem tooling than Nginx; lower raw throughput than Envoy at extreme scale.

---

### ADR-006: Redis for Cache and Queue

**Problem:** Cache and queue technology.  
**Decision:** Redis (using Valkey-compatible interface where possible)  
**Reason:** Widely supported, BullMQ provides production-grade queuing, Redis Pub/Sub for simple messaging.  
**Trade-offs:** Adds a service dependency; must be persisted for queue reliability.

---

### ADR-007: S3-Compatible Storage Abstraction

**Problem:** Object storage vendor selection.  
**Decision:** Storage abstraction layer; local MinIO for development, pluggable for production (R2, B2, S3, Wasabi).  
**Reason:** No vendor lock-in, works on any VPS.  
**Trade-offs:** Additional abstraction layer to maintain.

---

### ADR-008: Argon2id for Password Hashing

**Problem:** Password storage algorithm.  
**Decision:** Argon2id  
**Reason:** Winner of Password Hashing Competition, memory-hard, resistant to GPU attacks.  
**Trade-offs:** Slower than bcrypt intentionally (security property).

---

### ADR-009: pgBackRest for Backups

**Problem:** PostgreSQL backup solution.  
**Decision:** pgBackRest  
**Reason:** Full PITR, WAL archiving, compression, encryption, backup verification, widely deployed.  
**Trade-offs:** More complex than pg_dump; requires configuration.

---

### ADR-010: Prometheus + Grafana for Monitoring

**Problem:** Observability stack.  
**Decision:** Prometheus (metrics), Grafana (dashboards), Loki (logs), OpenTelemetry (traces).  
**Reason:** Open source, widely adopted, large community, self-hostable.  
**Trade-offs:** Requires disk space for metrics retention; Loki may need tuning at high log volume.

---

## Network Architecture

All internal service communication happens on a private Docker network.

**Public-facing ports (via Caddy):**
- 80 (redirects to 443)
- 443 (HTTPS)

**Internal ports (never exposed publicly):**
- PostgreSQL: 5432 (internal only)
- PgBouncer: 5433 (internal only)
- Redis: 6379 (internal only)
- Auth API: 3001 (internal only)
- REST API: 3002 (internal only)
- Realtime: 3003 (internal only)
- Storage API: 3004 (internal only)
- Control API: 3000 (internal only)
- Prometheus: 9090 (internal only)
- Grafana: 3005 (internal only)

---

## Security Architecture

See [security.md](./security.md) for full details.

**Principles:**
1. TLS everywhere — no unencrypted traffic
2. Never expose PostgreSQL/Redis ports publicly
3. Least privilege for all database roles
4. RLS enabled on all application tables
5. Separate service-role, anon-role, authenticated-role
6. Secrets encrypted at rest — never in plaintext tables
7. Audit logs append-only from application users
8. Rate limiting on all public endpoints
9. CSRF protection on all mutating endpoints
10. Argon2id password hashing

---

## Data Flow

### API Request (Public)

```
Browser
  → Cloudflare (WAF, DDoS, CDN)
  → Caddy (TLS termination, routing)
  → API Service (JWT validation, RLS context, rate limit)
  → PgBouncer (connection pooling)
  → PostgreSQL (RLS enforced)
  → Response
```

### File Upload

```
Client
  → Caddy
  → Storage API (validates JWT, checks bucket policy)
  → S3-compatible backend (actual binary)
  → PostgreSQL (metadata stored)
```

### Realtime

```
Client WebSocket
  → Caddy (WebSocket proxy)
  → Realtime Service (auth check)
  → PostgreSQL WAL / logical replication
  → Realtime Service (filter by project/policy)
  → Client WebSocket
```

### Authentication

```
Client (email/password)
  → Auth Service
  → Argon2id verify
  → Issue JWT + refresh token (secure cookie)
  → Session stored in PostgreSQL
```

---

## Repository Structure

```
owndatabase/
├── platform/
│   ├── control-plane/          # Control API (TypeScript/Fastify)
│   ├── data-plane/
│   │   ├── api-service/        # Auto REST API
│   │   ├── auth-service/       # Authentication
│   │   ├── realtime-service/   # WebSocket/WAL
│   │   └── storage-api/        # File storage
│   ├── dashboard/              # Next.js dashboard
│   ├── cli/                    # Platform CLI
│   ├── mcp-server/             # MCP server for AI agents
│   ├── workers/
│   │   ├── queue-worker/       # BullMQ worker
│   │   ├── cron-scheduler/     # Cron service
│   │   └── image-processor/    # Image transformation
│   ├── shared/                 # Shared TypeScript types/utilities
│   ├── migrations/             # Control plane DB migrations
│   └── scripts/                # Utility scripts
├── infrastructure/
│   ├── docker/                 # Dockerfiles
│   ├── caddy/                  # Caddyfile configurations
│   ├── prometheus/             # Prometheus config
│   ├── grafana/                # Grafana dashboards
│   ├── loki/                   # Loki configuration
│   ├── pgbouncer/              # PgBouncer config
│   └── pgbackrest/             # pgBackRest config
├── docs/
│   ├── architecture.md
│   ├── security.md
│   ├── database.md
│   ├── auth.md
│   ├── storage.md
│   ├── realtime.md
│   ├── backups.md
│   ├── ha.md
│   ├── deployment.md
│   ├── cost-optimization.md
│   └── migration.md
├── docker-compose.yml
├── docker-compose.override.yml
├── .env.example
├── Makefile
└── README.md
```

---

## MVP Scope

See [MVP milestones](./implementation-plan.md) for detailed breakdown.

**MVP includes:**
1. PostgreSQL + PgBouncer
2. Control Plane Dashboard (Next.js)
3. Project management
4. SQL editor
5. Database tables UI
6. Auto-generated REST API
7. API keys
8. Authentication (email/password, OAuth Google/GitHub)
9. RLS integration
10. Object Storage (MinIO local, S3-compatible production)
11. Basic Realtime (WAL-based)
12. Backup (pgBackRest)
13. Restore
14. Monitoring (Prometheus + Grafana)
15. Logs (Loki)
16. Docker Compose deployment

**MVP excludes (future phases):**
- Kubernetes
- Multi-region
- HA / Patroni
- GraphQL
- Serverless Functions
- Custom SMTP configuration UI
- Firebase migration tooling
- Billing
