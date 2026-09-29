-- Branches: a project created from another project's schema (preview / dev
-- databases). Branch-only migrations can be merged back into the parent, so
-- applied migrations now keep their SQL.
ALTER TABLE control_plane.projects
    ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES control_plane.projects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS branch_name VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_projects_parent ON control_plane.projects(parent_project_id) WHERE parent_project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_branch_name ON control_plane.projects(parent_project_id, branch_name) WHERE parent_project_id IS NOT NULL;

ALTER TABLE control_plane.project_migrations ADD COLUMN IF NOT EXISTS sql TEXT;
