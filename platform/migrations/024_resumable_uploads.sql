-- Resumable uploads (TUS 1.0, docs/storage.md → Resumable uploads)
CREATE TABLE IF NOT EXISTS storage.resumable_uploads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL,
    bucket_id       UUID NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,                  -- object path in the bucket
    owner           UUID,                           -- user who started it (null for service / platform)
    owner_key       TEXT NOT NULL,                  -- API key id / user: only the creator may continue it
    upload_length   BIGINT NOT NULL,
    upload_offset   BIGINT NOT NULL DEFAULT 0,
    chunk_sizes     BIGINT[] NOT NULL DEFAULT '{}', -- stored chunks, in order
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    cache_control   TEXT,
    user_metadata   JSONB NOT NULL DEFAULT '{}',
    upsert          BOOLEAN NOT NULL DEFAULT false,
    locked_until    TIMESTAMPTZ,                    -- a PATCH in progress
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resumable_uploads_expires ON storage.resumable_uploads(expires_at);
CREATE INDEX IF NOT EXISTS idx_resumable_uploads_project ON storage.resumable_uploads(project_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.resumable_uploads TO odb_storage;
