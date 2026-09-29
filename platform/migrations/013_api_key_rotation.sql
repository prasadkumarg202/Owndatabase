-- API key rotation: a rotated key points at the key it replaced; the old key
-- keeps working until its expires_at (the grace period).
ALTER TABLE control_plane.api_keys
    ADD COLUMN IF NOT EXISTS rotated_from UUID REFERENCES control_plane.api_keys(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS rotated_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_keys_rotated_from ON control_plane.api_keys(rotated_from) WHERE rotated_from IS NOT NULL;
