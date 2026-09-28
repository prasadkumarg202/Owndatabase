CREATE TABLE IF NOT EXISTS control_plane.query_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES control_plane.platform_users(id),
    query TEXT NOT NULL,
    duration_ms INTEGER,
    row_count INTEGER,
    error TEXT,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON control_plane.query_history(project_id, executed_at DESC);
CREATE INDEX ON control_plane.query_history(user_id, executed_at DESC);
