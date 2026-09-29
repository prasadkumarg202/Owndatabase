-- Per-key request cap (requests/minute across all clients of the key; NULL =
-- only the role's per-client default). allowed_ips (IP / CIDR list) already
-- exists on api_keys and is now enforced by every data-plane service.
ALTER TABLE control_plane.api_keys
    ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0);
