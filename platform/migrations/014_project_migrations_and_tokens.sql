-- ── Per-project schema migrations (odb db push) ──────────────────────────────
-- Migrations run on the project's own owner-role connection (never as the
-- platform superuser). They are recorded in the same transaction through
-- odb_meta.record_migration(), which identifies the project by session_user.
CREATE TABLE IF NOT EXISTS control_plane.project_migrations (
    project_id   UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    version      VARCHAR(32) NOT NULL,
    name         VARCHAR(200) NOT NULL DEFAULT '',
    checksum     CHAR(64) NOT NULL,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_by   UUID REFERENCES control_plane.platform_users(id) ON DELETE SET NULL,
    execution_ms INTEGER,
    source       VARCHAR(20) NOT NULL DEFAULT 'push',   -- push | pull (baseline) | repair
    PRIMARY KEY (project_id, version)
);

CREATE SCHEMA IF NOT EXISTS odb_meta;
GRANT USAGE ON SCHEMA odb_meta TO PUBLIC;

CREATE OR REPLACE FUNCTION odb_meta.record_migration(p_version TEXT, p_name TEXT, p_checksum TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, control_plane
AS $$
DECLARE
    pid UUID;
BEGIN
    -- session_user is the LOGIN role of the connection (current_user is the definer here)
    SELECT id INTO pid FROM control_plane.projects
    WHERE left(db_schema || '_owner', 63) = session_user::text;
    IF pid IS NULL THEN
        RAISE EXCEPTION 'record_migration may only be called by a project owner role' USING ERRCODE = '42501';
    END IF;
    IF p_version !~ '^[0-9]{1,32}$' THEN
        RAISE EXCEPTION 'invalid migration version %', p_version USING ERRCODE = '22023';
    END IF;
    INSERT INTO control_plane.project_migrations (project_id, version, name, checksum)
    VALUES (pid, p_version, left(coalesce(p_name, ''), 200), p_checksum);
END;
$$;

REVOKE ALL ON FUNCTION odb_meta.record_migration(TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT left(db_schema || '_owner', 63) AS role FROM control_plane.projects LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = r.role) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION odb_meta.record_migration(TEXT, TEXT, TEXT) TO %I', r.role);
        END IF;
    END LOOP;
END $$;

-- ── Personal access tokens (CLI / CI, e.g. GitHub Actions) ───────────────────
CREATE TABLE IF NOT EXISTS control_plane.personal_access_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES control_plane.platform_users(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,
    token_hash   CHAR(64) NOT NULL UNIQUE,
    token_prefix VARCHAR(20) NOT NULL,
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pat_user ON control_plane.personal_access_tokens(user_id);
