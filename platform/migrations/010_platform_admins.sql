-- Platform administrators: may see cluster-wide data (raw Prometheus queries,
-- cluster backups). Organization owners are NOT platform admins — every signup
-- owns a personal organization. The first registered user becomes admin; more
-- can be granted here or with PLATFORM_ADMIN_EMAILS.
ALTER TABLE control_plane.platform_users
    ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE control_plane.platform_users SET is_platform_admin = TRUE
WHERE id = (SELECT id FROM control_plane.platform_users ORDER BY created_at, id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM control_plane.platform_users WHERE is_platform_admin);
