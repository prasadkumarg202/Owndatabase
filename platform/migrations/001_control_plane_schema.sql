-- OwnDatabase — Control Plane Schema

--
-- This schema is for the OwnDatabase control plane itself.
-- It manages organizations, projects, users, servers, etc.
-- It lives in the `control_plane` PostgreSQL schema.
--
-- Application data (per project) lives in separate schemas/databases.
--

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create control plane schema
CREATE SCHEMA IF NOT EXISTS control_plane;

SET search_path TO control_plane, public;

-- ================================================================
-- ORGANIZATIONS
-- ================================================================

CREATE TABLE IF NOT EXISTS organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,
    plan            VARCHAR(50) NOT NULL DEFAULT 'free',
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug ON organizations(slug);

-- ================================================================
-- PLATFORM USERS (control plane users, not application users)
-- ================================================================

CREATE TABLE IF NOT EXISTS platform_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    name            VARCHAR(255),
    password_hash   VARCHAR(255),           -- Argon2id hash
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret      VARCHAR(255),           -- TOTP secret (encrypted)
    avatar_url      VARCHAR(1000),
    last_login_at   TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_platform_users_email ON platform_users(email);

-- ================================================================
-- ORGANIZATION MEMBERS
-- ================================================================

CREATE TYPE org_role AS ENUM ('owner', 'admin', 'developer', 'viewer', 'billing', 'support');

CREATE TABLE IF NOT EXISTS organization_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    role            org_role NOT NULL DEFAULT 'developer',
    invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    joined_at       TIMESTAMPTZ,
    invited_by      UUID REFERENCES platform_users(id),
    UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

-- ================================================================
-- PROJECTS
-- ================================================================

CREATE TYPE project_status AS ENUM ('active', 'paused', 'inactive', 'failed', 'creating', 'deleting');
CREATE TYPE project_region AS ENUM ('local', 'in-south-1', 'us-east-1', 'eu-west-1');

CREATE TABLE IF NOT EXISTS projects (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    slug                VARCHAR(100) NOT NULL,
    status              project_status NOT NULL DEFAULT 'creating',
    region              project_region NOT NULL DEFAULT 'local',
    plan                VARCHAR(50) NOT NULL DEFAULT 'free',
    db_host             VARCHAR(255),
    db_port             INTEGER NOT NULL DEFAULT 5432,
    db_name             VARCHAR(100),
    db_schema           VARCHAR(100),       -- schema within shared db
    db_pooler_host      VARCHAR(255),
    db_pooler_port      INTEGER NOT NULL DEFAULT 5433,
    api_endpoint        VARCHAR(500),
    storage_endpoint    VARCHAR(500),
    realtime_endpoint   VARCHAR(500),
    auth_endpoint       VARCHAR(500),
    settings            JSONB NOT NULL DEFAULT '{}',
    metadata            JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug)
);

CREATE INDEX idx_projects_org ON projects(organization_id);
CREATE INDEX idx_projects_status ON projects(status);

-- ================================================================
-- ENVIRONMENTS
-- ================================================================

CREATE TYPE env_type AS ENUM ('development', 'staging', 'production');

CREATE TABLE IF NOT EXISTS environments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    type            env_type NOT NULL DEFAULT 'development',
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE INDEX idx_environments_project ON environments(project_id);

-- ================================================================
-- SERVERS
-- ================================================================

CREATE TYPE server_status AS ENUM ('active', 'inactive', 'unreachable', 'maintenance');
CREATE TYPE server_provider AS ENUM ('manual', 'hetzner', 'digitalocean', 'vultr', 'linode', 'contabo', 'aws', 'gcp', 'azure', 'other');

CREATE TABLE IF NOT EXISTS servers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    hostname        VARCHAR(255) NOT NULL,
    ip_address      VARCHAR(100),
    ssh_port        INTEGER NOT NULL DEFAULT 22,
    provider        server_provider NOT NULL DEFAULT 'manual',
    region          VARCHAR(100),
    cpu_cores       INTEGER,
    ram_gb          INTEGER,
    disk_gb         INTEGER,
    status          server_status NOT NULL DEFAULT 'inactive',
    agent_version   VARCHAR(50),
    last_seen_at    TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_servers_org ON servers(organization_id);
CREATE INDEX idx_servers_status ON servers(status);

-- ================================================================
-- API KEYS
-- ================================================================

CREATE TYPE api_key_type AS ENUM ('anon', 'authenticated', 'service_role', 'admin');

CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    key_hash        VARCHAR(255) NOT NULL UNIQUE,   -- SHA-256 hash of actual key
    key_prefix      VARCHAR(20) NOT NULL,            -- First 12 chars for display
    type            api_key_type NOT NULL DEFAULT 'anon',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    allowed_ips     JSONB DEFAULT '[]',              -- IP allowlist
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES platform_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_project ON api_keys(project_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- ================================================================
-- SECRETS
-- ================================================================

CREATE TABLE IF NOT EXISTS secrets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    environment_id  UUID REFERENCES environments(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    value_encrypted BYTEA NOT NULL,     -- AES-256-GCM encrypted value
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID REFERENCES platform_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name, version)
);

CREATE INDEX idx_secrets_project ON secrets(project_id);
CREATE INDEX idx_secrets_env ON secrets(environment_id);

-- ================================================================
-- PLATFORM USER SESSIONS
-- ================================================================

CREATE TABLE IF NOT EXISTS platform_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL UNIQUE,
    refresh_token_hash VARCHAR(255) UNIQUE,
    ip_address      VARCHAR(100),
    user_agent      TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_platform_sessions_user ON platform_sessions(user_id);
CREATE INDEX idx_platform_sessions_token ON platform_sessions(token_hash);

-- ================================================================
-- PLATFORM VERIFICATION TOKENS
-- ================================================================

CREATE TYPE token_purpose AS ENUM ('email_verification', 'password_reset', 'invite');

CREATE TABLE IF NOT EXISTS verification_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES platform_users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL UNIQUE,
    purpose         token_purpose NOT NULL,
    email           VARCHAR(255),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_verification_tokens_hash ON verification_tokens(token_hash);

-- ================================================================
-- BACKUPS
-- ================================================================

CREATE TYPE backup_type AS ENUM ('full', 'differential', 'incremental', 'wal');
CREATE TYPE backup_status AS ENUM ('pending', 'running', 'completed', 'failed', 'verified', 'deleted');

CREATE TABLE IF NOT EXISTS backups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type            backup_type NOT NULL,
    status          backup_status NOT NULL DEFAULT 'pending',
    size_bytes      BIGINT,
    duration_ms     INTEGER,
    storage_path    VARCHAR(1000),
    storage_bucket  VARCHAR(255),
    wal_start_lsn   VARCHAR(50),
    wal_end_lsn     VARCHAR(50),
    restore_point   VARCHAR(255),
    is_encrypted    BOOLEAN NOT NULL DEFAULT TRUE,
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    error_message   TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES platform_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backups_project ON backups(project_id);
CREATE INDEX idx_backups_status ON backups(status);
CREATE INDEX idx_backups_created ON backups(created_at DESC);

-- ================================================================
-- DEPLOYMENTS
-- ================================================================

CREATE TYPE deploy_status AS ENUM ('pending', 'building', 'deploying', 'health_checking', 'success', 'failed', 'rolled_back');

CREATE TABLE IF NOT EXISTS deployments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id  UUID REFERENCES environments(id),
    status          deploy_status NOT NULL DEFAULT 'pending',
    git_commit      VARCHAR(100),
    git_branch      VARCHAR(255),
    image_tag       VARCHAR(255),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    rollback_of     UUID REFERENCES deployments(id),
    logs            TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES platform_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deployments_project ON deployments(project_id);
CREATE INDEX idx_deployments_status ON deployments(status);

-- ================================================================
-- AUDIT LOGS (append-only)
-- ================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type      VARCHAR(100) NOT NULL,
    actor_id        UUID,
    actor_type      VARCHAR(50) NOT NULL DEFAULT 'user',  -- user, api_key, system
    target_type     VARCHAR(100),
    target_id       VARCHAR(255),
    project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    ip_address      VARCHAR(100),
    user_agent      TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'
    -- NO updated_at — this table is append-only
);

CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_project ON audit_logs(project_id);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);

-- Prevent updates and deletes on audit_logs (security requirement)
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs are immutable and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

CREATE TRIGGER audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

-- ================================================================
-- METRICS SUMMARY (lightweight usage tracking)
-- ================================================================

CREATE TABLE IF NOT EXISTS usage_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date            DATE NOT NULL,
    api_requests    BIGINT NOT NULL DEFAULT 0,
    db_queries      BIGINT NOT NULL DEFAULT 0,
    storage_uploads BIGINT NOT NULL DEFAULT 0,
    storage_bytes   BIGINT NOT NULL DEFAULT 0,
    bandwidth_bytes BIGINT NOT NULL DEFAULT 0,
    auth_logins     INTEGER NOT NULL DEFAULT 0,
    realtime_msgs   BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, date)
);

CREATE INDEX idx_usage_metrics_project_date ON usage_metrics(project_id, date DESC);

-- ================================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'organizations', 'platform_users', 'organization_members',
        'projects', 'environments', 'servers', 'api_keys', 'secrets',
        'backups', 'deployments', 'usage_metrics'
    ]
    LOOP
        EXECUTE format('
            CREATE TRIGGER set_updated_at_%s
            BEFORE UPDATE ON %s
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        ', t, t);
    END LOOP;
END;
$$;
