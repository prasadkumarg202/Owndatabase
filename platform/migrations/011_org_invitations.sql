-- Organization invitations: invite anyone by email (they may not have an
-- account yet). The link carries a random token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS control_plane.organization_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES control_plane.organizations(id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(50) NOT NULL,
    token_hash      VARCHAR(64) NOT NULL UNIQUE,
    invited_by      UUID REFERENCES control_plane.platform_users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_at     TIMESTAMPTZ,
    accepted_by     UUID REFERENCES control_plane.platform_users(id) ON DELETE SET NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- one open invitation per email per organization
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_invitations_open
    ON control_plane.organization_invitations (organization_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
