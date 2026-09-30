-- Secrets vault (docs/vault.md): envelope encryption.
-- Each project (scope = project id; 'platform' for platform-wide secrets) has a data key (DEK),
-- stored only wrapped by a master key (KEK) that lives in the control API's environment.

CREATE TABLE IF NOT EXISTS control_plane.vault_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope        TEXT NOT NULL,
    version      INTEGER NOT NULL,
    kek_id       TEXT NOT NULL,                  -- which master key wraps it
    wrapped_key  BYTEA NOT NULL,                 -- AES-256-GCM(KEK, DEK), AAD = scope + version
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at   TIMESTAMPTZ,
    UNIQUE (scope, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vault_keys_active ON control_plane.vault_keys(scope) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vault_keys_kek ON control_plane.vault_keys(kek_id);

-- Every reveal, rotation and migration
CREATE TABLE IF NOT EXISTS control_plane.vault_audit (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor       TEXT NOT NULL,                   -- service name, platform user id, or 'system'
    project_id  UUID,
    action      TEXT NOT NULL,                   -- reveal | rotate_project_key | rotate_master_key | migrate
    detail      JSONB NOT NULL DEFAULT '{}',
    ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_vault_audit_project ON control_plane.vault_audit(project_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_audit_at ON control_plane.vault_audit(at DESC);
