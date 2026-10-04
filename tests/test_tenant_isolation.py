"""Tenant isolation (migration 022): each project's API roles reach only its own schema; the shared
anon / authenticated / service_role reach no project schema and no auth.* / storage.* table; RLS policies
written "TO authenticated" keep working. Privilege checks read the database through the docker CLI."""
import shutil
import subprocess

import pytest
from odb import create_project


def psql(query: str) -> str:
    if not shutil.which("docker"):
        pytest.skip("needs the docker CLI")
    pw = subprocess.run(["docker", "exec", "owndatabase-postgres", "printenv", "POSTGRES_PASSWORD"], capture_output=True, text=True).stdout.strip()
    p = subprocess.run(["docker", "exec", "-e", f"PGPASSWORD={pw}", "owndatabase-postgres", "psql", "-h", "127.0.0.1", "-U", "postgres",
                        "-d", "owndatabase", "-tAc", query], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()


def role(schema: str, r: str) -> str:
    return psql(f"select odb_meta.api_role('{schema}', '{r}')")


@pytest.fixture(scope="module")
def two(owner):
    a, b = create_project(owner, "iso a"), create_project(owner, "iso b")
    for p in (a, b):
        p.sql("create table items (id int primary key, owner uuid default auth.uid(), body text);"
              "alter table items enable row level security;"
              "create policy mine on items for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());"
              "create function add_one(x int) returns int language sql as $$ select x + 1 $$;")
    return a, b


def test_project_roles_reach_only_their_own_schema(two):
    a, b = two
    for r in ("anon", "authenticated", "service_role"):
        ra = role(a.schema, r)
        assert psql(f"select has_schema_privilege('{ra}', '{a.schema}', 'USAGE')") == "t"
        assert psql(f"select has_schema_privilege('{ra}', '{b.schema}', 'USAGE')") == "f", (r, ra)
    assert psql(f"select rolbypassrls from pg_roles where rolname = '{role(a.schema, 'service_role')}'") == "t"
    assert psql(f"select rolbypassrls or rolcanlogin from pg_roles where rolname = '{role(a.schema, 'anon')}'") == "f"


def test_shared_roles_reach_no_project_schema_or_platform_tables():
    open_schemas = psql("select count(*) from pg_namespace n where nspname like 'project\\_%' and exists "
                        "(select 1 from aclexplode(n.nspacl) x where x.grantee in (0, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole))")
    assert open_schemas == "0"
    for t in ("auth.users", "auth.user_passwords", "auth.sessions", "auth.refresh_tokens", "storage.objects", "storage.buckets"):
        for r in ("anon", "authenticated", "service_role"):
            assert psql(f"select has_table_privilege('{r}', '{t}', 'SELECT')") == "f", (r, t)
    assert psql("select has_schema_privilege('service_role', 'control_plane', 'USAGE')") == "f"


def test_regranting_to_shared_roles_is_undone(two):
    a, _ = two
    # a Supabase-style migration line run by the project owner
    a.sql(f'grant usage on schema "{a.schema}" to anon, authenticated, service_role')
    assert psql(f"select has_schema_privilege('anon', '{a.schema}', 'USAGE') or has_schema_privilege('service_role', '{a.schema}', 'USAGE')") == "f"
    assert psql(f"select has_schema_privilege('{role(a.schema, 'anon')}', '{a.schema}', 'USAGE')") == "t"


def test_api_still_works_with_project_roles(two):
    a, _ = two
    admin = a.rest("POST", "items", key=a.service_key, json={"id": 1, "body": "service"}, headers={"Prefer": "return=representation"})
    assert admin.status_code in (200, 201), admin.text
    assert a.rest("POST", "rpc/add_one", json={"x": 41}).json() == 42
    # RLS policies "TO authenticated" still apply to the project's authenticated role
    u = a.new_user()
    tok = u["access_token"]
    r = a.rest("POST", "items", token=tok, json={"id": 2, "body": "mine"}, headers={"Prefer": "return=representation"})
    assert r.status_code in (200, 201), r.text
    assert [x["body"] for x in a.rest("GET", "items?select=body", token=tok).json()] == ["mine"]
    assert a.rest("GET", "items?select=body").json() == []  # anon: no policy
    assert len(a.rest("GET", "items?select=body", key=a.service_key).json()) == 2  # service role bypasses RLS


def test_deleting_a_project_drops_its_roles(owner):
    p = create_project(owner, "iso delete")
    r = role(p.schema, "service_role")
    assert psql(f"select count(*) from pg_roles where rolname = '{r}'") == "1"
    slug = owner.get(f"/projects/{p.id}").json()["slug"]
    assert owner.delete(f"/projects/{p.id}?confirm={slug}").status_code == 200
    assert psql(f"select count(*) from pg_roles where rolname = '{r}'") == "0"


SERVICE_ROLES = ("odb_auth", "odb_api", "odb_storage", "odb_realtime", "odb_worker", "odb_cron")


def test_services_connect_with_least_privilege_roles():
    for container, user in (("owndatabase-auth", "odb_auth"), ("owndatabase-api", "odb_api"), ("owndatabase-storage", "odb_storage"),
                            ("owndatabase-realtime", "odb_realtime"), ("owndatabase-queue-worker", "odb_worker"), ("owndatabase-cron-scheduler", "odb_cron")):
        url = subprocess.run(["docker", "exec", container, "printenv", "DATABASE_URL"], capture_output=True, text=True).stdout
        assert url.startswith(f"postgresql://{user}:"), container
    for r in SERVICE_ROLES:
        assert psql(f"select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb from pg_roles where rolname = '{r}'") == "f", r
        # nobody but the control API reads secrets, keys or platform users
        for t in ("control_plane.secrets", "control_plane.vault_keys", "control_plane.platform_users", "control_plane.backups" if r != "odb_cron" else "control_plane.secrets"):
            assert psql(f"select has_table_privilege('{r}', '{t}', 'SELECT')") == "f", (r, t)
    # each service reaches only its own data
    assert psql("select has_table_privilege('odb_auth', 'auth.user_passwords', 'SELECT')") == "t"
    assert psql("select has_table_privilege('odb_storage', 'auth.user_passwords', 'SELECT')") == "f"
    assert psql("select has_table_privilege('odb_auth', 'storage.objects', 'SELECT')") == "f"
    assert psql("select has_table_privilege('odb_api', 'auth.users', 'SELECT')") == "f"
    assert psql("select has_column_privilege('odb_api', 'control_plane.api_keys', 'key_hash', 'UPDATE')") == "f"


def test_api_services_can_switch_into_project_roles_but_hold_none_of_their_access(two):
    a, _ = two
    for svc in ("odb_api", "odb_realtime"):
        assert psql(f"select has_schema_privilege('{svc}', '{a.schema}', 'USAGE')") == "f", svc
        assert psql(f"select pg_has_role('{svc}', '{role(a.schema, 'service_role')}', 'SET')") == "t", svc
    for svc in ("odb_auth", "odb_storage", "odb_worker", "odb_cron"):
        assert psql(f"select pg_has_role('{svc}', '{role(a.schema, 'service_role')}', 'SET')") == "f", svc


def test_project_reads_only_its_own_users(owner):
    """Supabase apps read auth.users from SECURITY DEFINER functions; each project sees only its own rows."""
    a, b = create_project(owner, "users a"), create_project(owner, "users b")
    ua, ub = a.new_user(), b.new_user()
    rows = a.sql("select email from auth.users")["data"]
    assert [r["email"] for r in rows] == [ua["email"]], rows
    assert b.sql(f"select count(*) as n from auth.users where email = '{ua['email']}'")["data"][0]["n"] in (0, "0")
    # a Supabase-style signup trigger chain: definer function reads auth.users for the new user
    a.sql("""
        create table profiles (id uuid primary key references auth.users(id), email text);
        create function copy_email() returns trigger language plpgsql security definer set search_path = public as $$
        begin
          new.email := (select u.email from auth.users u where u.id = new.id);
          return new;
        end $$;
        create trigger trg before insert on profiles for each row execute function copy_email();
        insert into profiles (id) values ('""" + ua["user"]["id"] + """');""")
    assert a.sql("select email from profiles")["data"][0]["email"] == ua["email"]
    # the auth service still signs users up and in normally
    assert a.auth("POST", "token?grant_type=password", json={"email": ua["email"], "password": ua["password"]}).status_code == 200
