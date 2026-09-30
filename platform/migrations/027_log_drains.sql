-- Log drains (docs/log-drains.md): the queue worker forwards a project's logs to Datadog, Better Stack
-- (Logtail) or any HTTPS endpoint. The API key / signing secret is sealed by the vault (log_drain:<id>).
CREATE TABLE IF NOT EXISTS control_plane.log_drains (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id            UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL DEFAULT '',
    kind                  TEXT NOT NULL CHECK (kind IN ('webhook', 'datadog', 'logtail')),
    url                   TEXT,                           -- webhook URL, or an override of the provider's intake URL
    config                JSONB NOT NULL DEFAULT '{}',    -- datadog: { site }
    secret_sealed         TEXT,
    sources               TEXT[] NOT NULL DEFAULT '{audit,auth,functions,platform}',
    enabled               BOOLEAN NOT NULL DEFAULT true,
    cursor                JSONB NOT NULL DEFAULT '{}',    -- per source: last forwarded timestamp
    last_delivered_at     TIMESTAMPTZ,
    last_error            TEXT,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by            UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_log_drains_project ON control_plane.log_drains(project_id);

-- queue-worker: the drains (not their sealed secret; that comes from the vault) and the log sources
GRANT SELECT (id, project_id, name, kind, url, config, sources, enabled, cursor, consecutive_failures, next_attempt_at)
  ON control_plane.log_drains TO odb_worker;
GRANT UPDATE (cursor, last_delivered_at, last_error, consecutive_failures, next_attempt_at, enabled)
  ON control_plane.log_drains TO odb_worker;
GRANT SELECT (project_id, timestamp, event_type, actor_id, ip_address, metadata) ON control_plane.audit_logs TO odb_worker;
GRANT SELECT (project_id, function_id, created_at, status, status_code, duration_ms, error, logs) ON control_plane.function_logs TO odb_worker;
GRANT SELECT (id, slug) ON control_plane.functions TO odb_worker;
GRANT USAGE ON SCHEMA auth TO odb_worker;
GRANT SELECT (project_id, timestamp, event_type, user_id, ip_address, metadata) ON auth.auth_audit_log TO odb_worker;
