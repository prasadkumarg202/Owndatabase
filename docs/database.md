# OwnDatabase — Database Architecture

> **Version:** 0.1.0

---

## Database Philosophy

OwnDatabase is **PostgreSQL-first**. PostgreSQL is not hidden behind an abstraction.  
Developers have direct SQL access.  
The auto-generated REST API is a convenience layer, not a replacement for SQL.

---

## Schema Organization

The database is organized into separate PostgreSQL schemas:

| Schema | Purpose | Managed by |
|---|---|---|
| `control_plane` | Platform metadata (orgs, projects, users, keys) | Control Plane API |
| `auth` | Application user authentication | Auth Service |
| `storage` | File metadata (buckets, objects, signed URLs) | Storage API |
| `public` | Application tables (per project) | Application |
| `project_*` | Per-project application data | Application |

---

## PostgreSQL Role Hierarchy

```sql
postgres (superuser)
  └── platform_admin       -- Control plane operations
  └── service_role         -- Bypass RLS for internal use
  └── authenticated        -- Per-user row access (JWT claims)
  └── anon                 -- Public, unauthenticated access
  └── backup_role          -- Read-only replication
  └── monitoring           -- pg_stat_* views only
```

**Rules:**
- `postgres` superuser is never used by applications
- Applications connect as `service_role` or `authenticated`
- `service_role` may bypass RLS for internal operations
- `authenticated` respects all RLS policies (JWT sub = auth.uid())
- `anon` may only access publicly visible data

---

## Row Level Security

Every application table should have RLS enabled:

```sql
-- Enable RLS
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read their own records
CREATE POLICY "owner_select" ON properties
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- Service role bypasses all (for internal operations)
ALTER TABLE properties FORCE ROW LEVEL SECURITY;
```

**Helper functions** (from auth schema):
```sql
auth.uid()    -- Returns current user UUID from JWT
auth.role()   -- Returns current role string
auth.email()  -- Returns current user email
```

---

## Extensions

Only enabled explicitly per project (Project → Database → Extensions, or
`POST /projects/:id/extensions`). Both images ship them: the single-node
`owndatabase-postgres` image (postgis/postgis base + pgvector built in) and
Spilo in HA mode.

| Extension | Purpose | Default |
|---|---|---|
| `pgcrypto` | Cryptographic functions | ✅ Enabled |
| `uuid-ossp` | UUID generation | ✅ Enabled |
| `pg_stat_statements` | Query statistics | ✅ Enabled |
| `pg_trgm` | Fuzzy text search | ✅ Enabled |
| `postgis` | Geographic queries (PostGIS 3.5) | 🔘 Enable per project |
| `vector` | pgvector 0.8 embeddings, HNSW/IVFFlat indexes | 🔘 Enable per project |

---

## Example Application Schema (VizagProperty)

```sql
CREATE SCHEMA IF NOT EXISTS property_app;

-- Localities with PostGIS geography
CREATE TABLE property_app.localities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    mandal      VARCHAR(255),
    district    VARCHAR(255) NOT NULL DEFAULT 'Visakhapatnam',
    state       VARCHAR(100) NOT NULL DEFAULT 'Andhra Pradesh',
    location    GEOGRAPHY(POINT, 4326),  -- Requires PostGIS
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Properties
CREATE TABLE property_app.properties (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES auth.users(id),
    locality_id     UUID REFERENCES property_app.localities(id),
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    price           NUMERIC(15, 2),
    property_type   VARCHAR(50) NOT NULL,  -- 'sale', 'rent', 'lease'
    area_sqft       INTEGER,
    bedrooms        SMALLINT,
    bathrooms       SMALLINT,
    amenities       TEXT[],
    location        GEOGRAPHY(POINT, 4326),
    is_published    BOOLEAN NOT NULL DEFAULT FALSE,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS policies
ALTER TABLE property_app.properties ENABLE ROW LEVEL SECURITY;

-- Public can see published properties
CREATE POLICY "public_read" ON property_app.properties
    FOR SELECT TO anon
    USING (is_published = TRUE);

-- Authenticated users see their own + published
CREATE POLICY "auth_read" ON property_app.properties
    FOR SELECT TO authenticated
    USING (is_published = TRUE OR owner_id = auth.uid());

-- Only owners can create/update/delete
CREATE POLICY "owner_write" ON property_app.properties
    FOR ALL TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

-- Nearby search (requires PostGIS)
-- SELECT * FROM property_app.properties
-- WHERE ST_DWithin(location, ST_MakePoint(83.3, 17.7)::geography, 5000);
-- (5km radius around Visakhapatnam)
```

---

## Migration Strategy

Database migrations are plain SQL files, numbered sequentially:

```
platform/migrations/
    001_control_plane_schema.sql
    002_auth_schema.sql
    003_storage_schema.sql
    004_property_app_schema.sql
    ...
```

Apply with:
```bash
make migrate
```

Rollback:
```bash
make migrate-rollback
```

---

## Performance Tuning

### Configuration (per VPS size)

| RAM | shared_buffers | effective_cache_size | work_mem |
|---|---|---|---|
| 1 GB | 256 MB | 768 MB | 4 MB |
| 2 GB | 512 MB | 1536 MB | 8 MB |
| 4 GB | 1 GB | 3 GB | 16 MB |
| 8 GB | 2 GB | 6 GB | 32 MB |

### Indexes

Always create indexes for:
- Foreign keys
- Columns used in WHERE clauses
- Columns used in ORDER BY
- Text search columns (GIN index with pg_trgm)
- Geographic columns (GIST index)

### Query monitoring

Slow queries are logged at `log_min_duration_statement = 1000` (1 second).  
Use `pg_stat_statements` to find the top queries by total time.

```sql
SELECT query, calls, total_exec_time, mean_exec_time
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```
