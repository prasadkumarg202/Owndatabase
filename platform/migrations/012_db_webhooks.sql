-- Database webhooks: row changes on a project table → HTTP POST.
--
-- A row trigger writes each change to an outbox (db_webhook_events) in the
-- same transaction, so rolled-back changes never fire and committed ones are
-- never lost. The queue worker delivers the outbox with retries.

CREATE TABLE IF NOT EXISTS control_plane.db_webhooks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    name             VARCHAR(100) NOT NULL,
    schema_name      TEXT NOT NULL,
    table_name       TEXT NOT NULL,
    events           TEXT[] NOT NULL CHECK (events <@ ARRAY['insert', 'update', 'delete'] AND cardinality(events) > 0),
    url              TEXT NOT NULL,
    http_method      VARCHAR(10) NOT NULL DEFAULT 'POST',
    headers          JSONB NOT NULL DEFAULT '{}',
    secret_encrypted BYTEA,
    timeout_ms       INTEGER NOT NULL DEFAULT 5000,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       UUID REFERENCES control_plane.platform_users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS control_plane.db_webhook_events (
    id               BIGSERIAL PRIMARY KEY,
    webhook_id       UUID NOT NULL REFERENCES control_plane.db_webhooks(id) ON DELETE CASCADE,
    project_id       UUID NOT NULL,
    payload          JSONB NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | sending | delivered | failed
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_status_code INTEGER,
    last_error       TEXT,
    duration_ms      INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_db_webhook_events_due ON control_plane.db_webhook_events (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_db_webhook_events_hook ON control_plane.db_webhook_events (webhook_id, id DESC);

-- Trigger function. TG_ARGV[0] is the webhook id. It only fires when the
-- webhook exists, is enabled, and names exactly this schema.table, and that
-- schema belongs to the webhook's project, so a project that attaches the
-- function to its own table cannot feed another project's webhook.
CREATE OR REPLACE FUNCTION control_plane.db_webhook_fire()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, control_plane
AS $$
DECLARE
    hook_id UUID;
    hook    RECORD;
BEGIN
    BEGIN
        hook_id := TG_ARGV[0]::uuid;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;
    SELECT w.id, w.project_id, w.events INTO hook
    FROM control_plane.db_webhooks w
    JOIN control_plane.projects p ON p.id = w.project_id
    WHERE w.id = hook_id AND w.enabled
      AND w.schema_name = TG_TABLE_SCHEMA AND w.table_name = TG_TABLE_NAME
      AND p.db_schema = TG_TABLE_SCHEMA;
    IF NOT FOUND OR NOT (lower(TG_OP) = ANY (hook.events)) THEN
        RETURN NULL;
    END IF;

    INSERT INTO control_plane.db_webhook_events (webhook_id, project_id, payload)
    VALUES (hook.id, hook.project_id, jsonb_build_object(
        'type',       TG_OP,
        'table',      TG_TABLE_NAME,
        'schema',     TG_TABLE_SCHEMA,
        'record',     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
        'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
        'commit_timestamp', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ));
    PERFORM pg_notify('odb_db_webhooks', hook.id::text);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.db_webhook_fire() FROM PUBLIC;
