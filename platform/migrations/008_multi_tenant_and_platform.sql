-- Migration 008: multi-tenant auth, functions, restores, role hardening
--
-- Makes the shared `auth` schema project-aware (every end user belongs to
-- exactly one project), adds serverless function + restore bookkeeping, and
-- hardens the built-in database roles. Written to be idempotent.

-- ── Roles ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
    END IF;
END
$$;

-- service_role is used by trusted server-side keys and must bypass RLS.
ALTER ROLE service_role BYPASSRLS;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email() TO anon, authenticated, service_role;

-- ── Auth: project scoping ────────────────────────────────────────────────────
ALTER TABLE auth.users      ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE auth.otp_codes  ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE auth.oauth_states ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE auth.sessions   ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE auth.sessions   ADD COLUMN IF NOT EXISTS aal VARCHAR(10) NOT NULL DEFAULT 'aal1';
ALTER TABLE auth.mfa_factors ADD COLUMN IF NOT EXISTS last_used_step BIGINT;

-- email/phone are unique per project, not globally
ALTER TABLE auth.users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE auth.users DROP CONSTRAINT IF EXISTS users_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_users_project_email ON auth.users(project_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_users_project_phone ON auth.users(project_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_users_project ON auth.users(project_id);

ALTER TABLE auth.identities DROP CONSTRAINT IF EXISTS identities_provider_provider_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_identities_project_provider ON auth.identities(project_id, provider, provider_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_auth_users_project') THEN
        ALTER TABLE auth.users ADD CONSTRAINT fk_auth_users_project
            FOREIGN KEY (project_id) REFERENCES control_plane.projects(id) ON DELETE CASCADE;
    END IF;
END
$$;

-- ── Storage: FK to projects + object owner lookups ───────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_storage_buckets_project') THEN
        ALTER TABLE storage.buckets ADD CONSTRAINT fk_storage_buckets_project
            FOREIGN KEY (project_id) REFERENCES control_plane.projects(id) ON DELETE CASCADE;
    END IF;
END
$$;
ALTER TABLE storage.signed_urls ALTER COLUMN max_uses DROP NOT NULL;

-- ── Functions (Phase 8) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_plane.functions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    slug            VARCHAR(100) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    code            TEXT NOT NULL,
    runtime         VARCHAR(50) NOT NULL DEFAULT 'node20',
    timeout_ms      INTEGER NOT NULL DEFAULT 5000,
    memory_mb       INTEGER NOT NULL DEFAULT 128,
    verify_jwt      BOOLEAN NOT NULL DEFAULT TRUE,
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID REFERENCES control_plane.platform_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS control_plane.function_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    function_id     UUID NOT NULL REFERENCES control_plane.functions(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    status          VARCHAR(20) NOT NULL,      -- success | error | timeout
    status_code     INTEGER,
    duration_ms     INTEGER,
    logs            TEXT,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_function_logs_fn ON control_plane.function_logs(function_id, created_at DESC);

-- ── Restores (Phase 7) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_plane.restores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_id       UUID NOT NULL REFERENCES control_plane.backups(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | running | completed | failed
    target_time     TIMESTAMPTZ,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES control_plane.platform_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restores_project ON control_plane.restores(project_id, created_at DESC);

-- ── Cron jobs: unique names per project ──────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_cron_jobs_project_name ON control_plane.cron_jobs(project_id, name);

-- ── Realtime: include a size-safe payload ────────────────────────────────────
CREATE OR REPLACE FUNCTION control_plane.notify_realtime_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    payload  JSONB;
    rec      JSONB;
    old_rec  JSONB;
    body     TEXT;
BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN rec := to_jsonb(NEW); END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN old_rec := to_jsonb(OLD); END IF;

    payload := jsonb_build_object(
        'table', TG_TABLE_NAME,
        'schema', TG_TABLE_SCHEMA,
        'action', TG_OP,
        'record', COALESCE(rec, old_rec),
        'old_record', old_rec,
        'commit_timestamp', NOW()
    );
    body := payload::text;

    -- NOTIFY payloads are limited to 8000 bytes. Send a reference instead of
    -- truncating (truncation would produce invalid JSON).
    IF octet_length(body) > 7900 THEN
        body := jsonb_build_object(
            'table', TG_TABLE_NAME,
            'schema', TG_TABLE_SCHEMA,
            'action', TG_OP,
            'record', jsonb_build_object('id', COALESCE(rec, old_rec)->'id'),
            'truncated', true,
            'commit_timestamp', NOW()
        )::text;
    END IF;

    PERFORM pg_notify('owndatabase_changes', body);
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── updated_at on functions ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS set_updated_at_functions ON control_plane.functions;
CREATE TRIGGER set_updated_at_functions BEFORE UPDATE ON control_plane.functions
    FOR EACH ROW EXECUTE FUNCTION control_plane.set_updated_at();

-- ── Append-only audit tables must not be touched by FK actions ───────────────
-- ON DELETE SET NULL on an immutable table fires the "no update" trigger and
-- makes deleting a project/user/session fail. Keep the ids, drop the FKs.
ALTER TABLE control_plane.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_project_id_fkey;
ALTER TABLE control_plane.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_organization_id_fkey;
ALTER TABLE auth.auth_audit_log DROP CONSTRAINT IF EXISTS auth_audit_log_user_id_fkey;
ALTER TABLE auth.auth_audit_log DROP CONSTRAINT IF EXISTS auth_audit_log_session_id_fkey;
ALTER TABLE auth.auth_audit_log ADD COLUMN IF NOT EXISTS project_id UUID;
CREATE INDEX IF NOT EXISTS idx_auth_audit_project ON auth.auth_audit_log(project_id, timestamp DESC);

-- query history should disappear with its user
ALTER TABLE control_plane.query_history DROP CONSTRAINT IF EXISTS query_history_user_id_fkey;
ALTER TABLE control_plane.query_history ADD CONSTRAINT query_history_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES control_plane.platform_users(id) ON DELETE CASCADE;
