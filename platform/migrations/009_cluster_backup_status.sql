-- Cluster-level pgBackRest status (whole database, all projects), written by
-- the pgbackrest sidecar after every backup; read by GET /api/cluster/backups.
-- Single row (id = 1). `info` is one stanza entry from `pgbackrest info --output=json`.
CREATE TABLE IF NOT EXISTS control_plane.cluster_backup_status (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    info JSONB,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
