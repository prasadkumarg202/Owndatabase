CREATE TABLE IF NOT EXISTS control_plane.backup_configs (
    project_id UUID PRIMARY KEY REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    full_backup_cron VARCHAR(100) NOT NULL DEFAULT '0 2 * * 0',
    diff_backup_cron VARCHAR(100) NOT NULL DEFAULT '0 2 * * 1-6',
    retention_days INTEGER NOT NULL DEFAULT 30,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    s3_bucket VARCHAR(255),
    s3_prefix VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
