-- Project code may read its own project's users in auth.users, as in Supabase
-- (e.g. a SECURITY DEFINER trigger that looks up the signing-up user's email).
--
-- auth.users is shared by every project, so row-level security limits each project's owner role to
-- the rows of its own project. The auth service (odb_auth) keeps full access through its own policy;
-- superusers (control API, backup worker) bypass RLS; foreign-key checks are not subject to RLS.

-- the project a project-owner role belongs to (the role name is passed in: inside a SECURITY DEFINER
-- function current_user would be the definer)
CREATE OR REPLACE FUNCTION odb_meta.project_of_role(p_role name) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id FROM control_plane.projects WHERE left(db_schema || '_owner', 63) = p_role::text LIMIT 1
$$;
REVOKE ALL ON FUNCTION odb_meta.project_of_role(name) FROM PUBLIC;
GRANT USAGE ON SCHEMA odb_meta TO PUBLIC;
GRANT EXECUTE ON FUNCTION odb_meta.project_of_role(name) TO PUBLIC;

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS odb_auth_service ON auth.users;
CREATE POLICY odb_auth_service ON auth.users TO odb_auth USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS odb_project_reads_own_users ON auth.users;
CREATE POLICY odb_project_reads_own_users ON auth.users FOR SELECT TO PUBLIC
  USING (project_id = (SELECT odb_meta.project_of_role(current_user)));

-- project owners: read access (rows limited by the policy above)
CREATE OR REPLACE FUNCTION odb_meta.grant_project_auth_read(p_schema text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE o text := left(p_schema || '_owner', 63);
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = o) THEN
    EXECUTE format('GRANT SELECT ON auth.users TO %I', o);
  END IF;
END $$;
REVOKE ALL ON FUNCTION odb_meta.grant_project_auth_read(text) FROM PUBLIC;

DO $$
DECLARE s text;
BEGIN
  FOR s IN SELECT db_schema FROM control_plane.projects WHERE db_schema IS NOT NULL LOOP
    PERFORM odb_meta.grant_project_auth_read(s);
  END LOOP;
END $$;
