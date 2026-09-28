-- Storage schema for file/object storage metadata
-- Binary objects are stored in S3-compatible backend.
-- Only metadata lives in PostgreSQL.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS storage;

SET search_path TO storage, public;

-- ================================================================
-- BUCKETS
-- ================================================================

CREATE TABLE IF NOT EXISTS buckets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL,                      -- references control_plane.projects
    name            VARCHAR(255) NOT NULL,
    is_public       BOOLEAN NOT NULL DEFAULT FALSE,
    file_size_limit BIGINT,                             -- max bytes per file
    allowed_mime_types JSONB DEFAULT '[]',              -- e.g. ["image/jpeg", "image/png"]
    backend_bucket  VARCHAR(255),                       -- actual S3 bucket name
    backend_prefix  VARCHAR(255),                       -- path prefix in S3 bucket
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE INDEX idx_buckets_project ON buckets(project_id);

-- ================================================================
-- OBJECTS (file metadata)
-- ================================================================

CREATE TABLE IF NOT EXISTS objects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id       UUID NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    name            VARCHAR(1000) NOT NULL,              -- path within bucket, e.g. "images/avatar.jpg"
    owner           UUID,                                -- user who owns this object (auth.users.id)
    size_bytes      BIGINT,
    mime_type       VARCHAR(255),
    etag            VARCHAR(255),
    storage_path    VARCHAR(2000),                       -- actual path in S3-compatible storage
    metadata        JSONB NOT NULL DEFAULT '{}',
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bucket_id, name)
);

CREATE INDEX idx_objects_bucket ON objects(bucket_id);
CREATE INDEX idx_objects_owner ON objects(owner) WHERE owner IS NOT NULL;
CREATE INDEX idx_objects_name ON objects(bucket_id, name);

-- ================================================================
-- SIGNED URLS (time-limited access tokens)
-- ================================================================

CREATE TABLE IF NOT EXISTS signed_urls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id       UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    token           VARCHAR(255) NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    max_uses        INTEGER DEFAULT 1,
    use_count       INTEGER NOT NULL DEFAULT 0,
    created_by      UUID,                               -- user who created
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_signed_urls_token ON signed_urls(token);
CREATE INDEX idx_signed_urls_object ON signed_urls(object_id);
CREATE INDEX idx_signed_urls_expires ON signed_urls(expires_at);

-- ================================================================
-- MULTIPART UPLOADS (for large file uploads)
-- ================================================================

CREATE TABLE IF NOT EXISTS multipart_uploads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id       UUID NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    object_name     VARCHAR(1000) NOT NULL,
    upload_id       VARCHAR(255) NOT NULL UNIQUE,       -- S3 multipart upload ID
    owner           UUID,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX idx_multipart_bucket ON multipart_uploads(bucket_id);

-- ================================================================
-- UPDATED_AT TRIGGERS
-- ================================================================

CREATE OR REPLACE FUNCTION storage.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_buckets
    BEFORE UPDATE ON buckets
    FOR EACH ROW EXECUTE FUNCTION storage.set_updated_at();

CREATE TRIGGER set_updated_at_objects
    BEFORE UPDATE ON objects
    FOR EACH ROW EXECUTE FUNCTION storage.set_updated_at();
