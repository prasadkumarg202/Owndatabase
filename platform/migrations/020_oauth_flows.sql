-- OAuth: supabase-js PKCE flow (?code= redirect exchanged with grant_type=pkce)

ALTER TABLE auth.oauth_states ADD COLUMN IF NOT EXISTS client_code_challenge TEXT;
ALTER TABLE auth.oauth_states ADD COLUMN IF NOT EXISTS client_code_challenge_method TEXT;

CREATE TABLE IF NOT EXISTS auth.flow_state (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID NOT NULL,
    auth_code               TEXT NOT NULL UNIQUE,   -- sha256 of the code handed to the app
    code_challenge          TEXT NOT NULL,
    code_challenge_method   TEXT NOT NULL,          -- s256 | plain
    user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider                TEXT,
    provider_access_token   TEXT,
    provider_refresh_token  TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_flow_state_expires ON auth.flow_state(expires_at);
