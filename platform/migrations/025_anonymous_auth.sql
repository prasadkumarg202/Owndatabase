-- Anonymous sign-ins (docs/anonymous-auth.md) and auth.jwt() for RLS policies:
--   using ((auth.jwt() ->> 'is_anonymous')::boolean is false)
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role, odb_auth;
DO $$
DECLARE r text;
BEGIN
  -- project owners use it in policies, like auth.uid()
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'project\_%\_owner' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION auth.jwt() TO %I', r);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS idx_auth_users_anonymous ON auth.users(project_id) WHERE is_anonymous;
