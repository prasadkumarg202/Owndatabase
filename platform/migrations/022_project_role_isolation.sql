-- Tenant isolation (docs/security.md → Project isolation).
--
-- Before: anon / authenticated / service_role were shared by every project and had USAGE + ALL on every
-- project schema, so SQL running as one project's API role could reach another project's tables, and
-- service_role could read auth.* / storage.* of all projects.
--
-- Now every project has its own API roles <schema>_anon / _authn / _svc. Only they get USAGE on the
-- project's schema. Each is a member of the matching shared role, so RLS policies written "TO anon" /
-- "TO authenticated" keep applying, but the shared roles no longer reach any project schema, auth.* or
-- storage.* tables.

CREATE SCHEMA IF NOT EXISTS odb_meta;

-- Keep in sync with projectApiRole() in platform/shared/platform-auth.ts
CREATE OR REPLACE FUNCTION odb_meta.api_role(p_schema text, p_role text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(p_schema) + 1 + length(s) <= 63 THEN p_schema || '_' || s
              ELSE 'p_' || left(md5(p_schema), 20) || '_' || s END
  FROM (SELECT CASE p_role WHEN 'anon' THEN 'anon' WHEN 'authenticated' THEN 'authn' WHEN 'service_role' THEN 'svc' END AS s) x
$$;

CREATE OR REPLACE FUNCTION odb_meta.secure_project_schema(p_schema text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r_anon text := odb_meta.api_role(p_schema, 'anon');
  r_auth text := odb_meta.api_role(p_schema, 'authenticated');
  r_svc  text := odb_meta.api_role(p_schema, 'service_role');
BEGIN
  IF to_regnamespace(quote_ident(p_schema)) IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r_anon) THEN EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT', r_anon); END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r_auth) THEN EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT', r_auth); END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r_svc)  THEN EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT', r_svc);  END IF;
  EXECUTE format('ALTER ROLE %I NOLOGIN NOBYPASSRLS', r_anon);
  EXECUTE format('ALTER ROLE %I NOLOGIN NOBYPASSRLS', r_auth);
  EXECUTE format('ALTER ROLE %I NOLOGIN BYPASSRLS', r_svc);   -- attributes are not inherited
  -- membership: policies "TO anon" etc. apply, and shared grants (auth.uid(), extensions, grants on own tables) are inherited
  EXECUTE format('GRANT anon TO %I', r_anon);
  EXECUTE format('GRANT authenticated TO %I', r_auth);
  EXECUTE format('GRANT service_role TO %I', r_svc);
  -- only this project's roles may use its schema
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon, authenticated, service_role, PUBLIC', p_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I, %I, %I', p_schema, r_anon, r_auth, r_svc);
END $$;

CREATE OR REPLACE FUNCTION odb_meta.drop_project_roles(p_schema text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[odb_meta.api_role(p_schema, 'anon'), odb_meta.api_role(p_schema, 'authenticated'), odb_meta.api_role(p_schema, 'service_role')] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('DROP OWNED BY %I', r);
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION odb_meta.secure_project_schema(text), odb_meta.drop_project_roles(text) FROM PUBLIC;

-- A project owner re-granting its schema to the shared roles (a habit from Supabase migrations) would
-- reopen it to every project: undo that after every GRANT.
CREATE OR REPLACE FUNCTION odb_meta.enforce_schema_isolation() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT n.nspname FROM pg_namespace n
    WHERE n.nspname LIKE 'project\_%'
      AND EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a
                  WHERE a.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid))
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon, authenticated, service_role, PUBLIC', s);
  END LOOP;
END $$;
DROP EVENT TRIGGER IF EXISTS odb_enforce_schema_isolation;
CREATE EVENT TRIGGER odb_enforce_schema_isolation ON ddl_command_end WHEN TAG IN ('GRANT')
  EXECUTE FUNCTION odb_meta.enforce_schema_isolation();

-- auth.* and storage.* hold every project's users and files: no API role reads them directly
-- (the services use their own connections; RLS helpers are functions).
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM anon, authenticated, service_role, PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM anon, authenticated, service_role, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE ALL ON TABLES FROM service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE ALL ON SEQUENCES FROM service_role;
DO $$ BEGIN
  IF to_regnamespace('storage') IS NOT NULL THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA storage FROM anon, authenticated, service_role, PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA storage FROM anon, authenticated, service_role, PUBLIC;
    REVOKE ALL ON SCHEMA storage FROM anon, authenticated, service_role, PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA storage REVOKE ALL ON TABLES FROM service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA storage REVOKE ALL ON SEQUENCES FROM service_role;
  END IF;
END $$;
REVOKE ALL ON FUNCTION control_plane.notify_realtime_change() FROM service_role;
DO $$ BEGIN
  IF to_regprocedure('control_plane.setup_realtime_trigger(text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION control_plane.setup_realtime_trigger(text, text) FROM service_role;
    REVOKE ALL ON FUNCTION control_plane.remove_realtime_trigger(text, text) FROM service_role;
  END IF;
END $$;

-- existing projects
DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT db_schema FROM control_plane.projects WHERE db_schema IS NOT NULL LOOP
    PERFORM odb_meta.secure_project_schema(s);
  END LOOP;
END $$;
