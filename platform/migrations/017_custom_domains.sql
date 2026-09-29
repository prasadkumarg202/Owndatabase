-- Custom domains: a hostname that serves one project's APIs (see platform/shared/domains.ts).
-- Ownership is proven with a DNS TXT record _odb-challenge.<hostname> = verification_token.
CREATE TABLE IF NOT EXISTS control_plane.custom_domains (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    hostname           VARCHAR(253) NOT NULL,
    verification_token VARCHAR(64) NOT NULL,
    status             VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | verified | failed
    verified_at        TIMESTAMPTZ,
    last_checked_at    TIMESTAMPTZ,
    last_error         TEXT,
    created_by         UUID REFERENCES control_plane.platform_users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_domains_hostname ON control_plane.custom_domains (lower(hostname));
CREATE INDEX IF NOT EXISTS idx_custom_domains_project ON control_plane.custom_domains (project_id);
