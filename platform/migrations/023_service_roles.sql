-- Least-privilege database roles for the services (docs/security.md → Service database roles).
-- The control API and the backup worker stay superuser: they create schemas / roles and run pg_dump.
-- The roles are created NOLOGIN here; the control API gives each one LOGIN and its password on
-- start (SERVICE_DB_PASSWORDS), so the passwords never live in SQL.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['odb_auth', 'odb_api', 'odb_storage', 'odb_realtime', 'odb_worker', 'odb_cron'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', r);
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA control_plane TO %I', r);
    EXECUTE format('GRANT SELECT ON control_plane.projects TO %I', r);
  END LOOP;
END $$;

-- every data-plane service authenticates API keys and resolves custom domains (platform/shared)
GRANT SELECT ON control_plane.api_keys, control_plane.organization_members, control_plane.custom_domains
  TO odb_auth, odb_api, odb_storage, odb_realtime;
GRANT UPDATE (last_used_at) ON control_plane.api_keys TO odb_auth, odb_api, odb_storage, odb_realtime;

-- auth-service: the auth schema
GRANT USAGE ON SCHEMA auth TO odb_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO odb_auth;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth TO odb_auth;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO odb_auth;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO odb_auth;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO odb_auth;

-- storage-api: the storage schema
DO $$ BEGIN
  IF to_regnamespace('storage') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA storage TO odb_storage;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA storage TO odb_storage;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA storage TO odb_storage;
    ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO odb_storage;
    ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO odb_storage;
  END IF;
END $$;

-- api-service: functions + their logs; project data only through the project's API roles
GRANT SELECT ON control_plane.functions TO odb_api;
GRANT INSERT ON control_plane.function_logs TO odb_api;

-- queue-worker: database-webhook deliveries
GRANT SELECT ON control_plane.db_webhooks TO odb_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON control_plane.db_webhook_events TO odb_worker;

-- cron-scheduler: cron jobs and scheduled backups
GRANT SELECT, UPDATE ON control_plane.cron_jobs TO odb_cron;
GRANT SELECT ON control_plane.backup_configs TO odb_cron;
GRANT SELECT, INSERT ON control_plane.backups TO odb_cron;

-- The API and realtime services switch into a project's API roles (SET ROLE) but get none of their
-- privileges otherwise (INHERIT FALSE).
CREATE OR REPLACE FUNCTION odb_meta.grant_project_roles_to_services(p_schema text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r text; svc text;
BEGIN
  FOREACH svc IN ARRAY ARRAY['odb_api', 'odb_realtime'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = svc) THEN CONTINUE; END IF;
    FOREACH r IN ARRAY ARRAY[odb_meta.api_role(p_schema, 'anon'), odb_meta.api_role(p_schema, 'authenticated'), odb_meta.api_role(p_schema, 'service_role')] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', r, svc);
      END IF;
    END LOOP;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION odb_meta.grant_project_roles_to_services(text) FROM PUBLIC;

-- new projects: secure_project_schema (migration 022) now also grants the roles to the services
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
  EXECUTE format('ALTER ROLE %I NOLOGIN BYPASSRLS', r_svc);
  EXECUTE format('GRANT anon TO %I', r_anon);
  EXECUTE format('GRANT authenticated TO %I', r_auth);
  EXECUTE format('GRANT service_role TO %I', r_svc);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon, authenticated, service_role, PUBLIC', p_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I, %I, %I', p_schema, r_anon, r_auth, r_svc);
  PERFORM odb_meta.grant_project_roles_to_services(p_schema);
END $$;

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT db_schema FROM control_plane.projects WHERE db_schema IS NOT NULL LOOP
    PERFORM odb_meta.grant_project_roles_to_services(s);
  END LOOP;
END $$;
