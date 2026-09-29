"""Per-project migrations (API + `odb db push/pull/reset`) and personal access tokens."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import requests

from odb import URLS, create_project

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "platform" / "cli"


def apply(p, version, sql, name="m", **kw):
    return p.owner.post(f"/projects/{p.id}/migrations", json={"version": version, "name": name, "sql": sql, **kw})


def tables(p):
    return {t["name"] for t in p.owner.get(f"/projects/{p.id}/tables").json()["data"]}


@pytest.fixture()
def proj(owner):
    return create_project(owner, "Migrations")


def test_apply_is_transactional_and_recorded(proj):
    r = apply(proj, "20260101000000", "create table todos (id bigint generated always as identity primary key, title text not null);", "todos")
    assert r.status_code == 201, r.text
    assert "todos" in tables(proj)
    assert apply(proj, "20260101000000", "create table todos (id bigint generated always as identity primary key, title text not null);").json()["status"] == "already_applied"
    assert apply(proj, "20260101000000", "select 1;").status_code == 409                       # edited after applying

    # a failing migration leaves nothing behind and is not recorded
    r = apply(proj, "20260102000000", "create table half (id int); insert into nope values (1);")
    assert r.status_code == 400 and "nope" in r.json()["message"], r.text
    assert "half" not in tables(proj)

    # dry run: executed, rolled back, not recorded
    r = apply(proj, "20260103000000", "create table dry (id int);", dry_run=True)
    assert r.status_code == 200 and r.json()["dry_run"] is True
    assert "dry" not in tables(proj)

    versions = [m["version"] for m in proj.owner.get(f"/projects/{proj.id}/migrations").json()["data"]]
    assert versions == ["20260101000000"]
    # the REST API sees the new table without a restart
    assert proj.rest("GET", "todos", key=proj.service_key).status_code == 200


def test_migrations_run_as_the_project_owner_not_the_platform(proj):
    for evil in ["reset role; select * from control_plane.projects;",
                 "set role postgres; create table control_plane.x (id int);",
                 "select * from control_plane.projects;"]:
        r = apply(proj, "20260201000000", evil)
        assert r.status_code == 400, (evil, r.text)
    # and cannot fake records for another project
    other = create_project(proj.owner, "Other")
    r = proj.owner.post(f"/projects/{proj.id}/execute", json={"query": "select odb_meta.record_migration('1','x','0')"})
    assert r.status_code == 200    # records for its own project only
    assert other.owner.get(f"/projects/{other.id}/migrations").json()["data"] == []


def test_transaction_control_rejected(proj):
    assert apply(proj, "20260301000000", "begin; create table t (id int); commit;").status_code == 400
    assert apply(proj, "20260301000000", "create index concurrently i on t (id);").status_code == 400


def test_repair_remote_schema_and_reset(proj):
    apply(proj, "20260401000000", "create table notes (id int primary key, body text); create index notes_body on notes (body);")
    r = proj.owner.post(f"/projects/{proj.id}/migrations/repair", json={"version": "20260401000001", "status": "applied", "name": "manual"})
    assert r.status_code == 200
    assert "20260401000001" in [m["version"] for m in proj.owner.get(f"/projects/{proj.id}/migrations").json()["data"]]
    proj.owner.post(f"/projects/{proj.id}/migrations/repair", json={"version": "20260401000001", "status": "reverted"})

    ddl = proj.owner.get(f"/projects/{proj.id}/migrations/remote-schema").json()["sql"]
    assert "CREATE TABLE notes" in ddl and proj.schema not in ddl and "CREATE SCHEMA" not in ddl, ddl[:500]

    u = proj.new_user()
    assert proj.owner.post(f"/projects/{proj.id}/database/reset", json={"confirm": "wrong"}).status_code == 400
    assert proj.owner.post(f"/projects/{proj.id}/database/reset", json={"confirm": proj.slug}).status_code == 200
    assert tables(proj) == set() and proj.owner.get(f"/projects/{proj.id}/migrations").json()["data"] == []
    assert proj.auth("GET", "user", token=u["access_token"]).status_code == 200            # auth users are kept
    # the pulled schema replays into the empty project
    assert apply(proj, "20260401000002", ddl, "remote_schema").status_code == 201, ddl[:300]
    assert "notes" in tables(proj)


def test_personal_access_tokens(owner):
    r = owner.post("/auth/tokens", json={"name": "ci", "expires_in_days": 30})
    assert r.status_code == 201, r.text
    tok = r.json()
    assert tok["token"].startswith("odb_pat_") and tok["token_prefix"] == tok["token"][:16]
    h = {"Authorization": f"Bearer {tok['token']}"}
    assert requests.get(f"{URLS['api']}/api/projects", headers=h, timeout=10).status_code == 200
    assert requests.get(f"{URLS['api']}/api/auth/me", headers=h, timeout=10).json()["email"] == owner.email
    # a token cannot mint tokens
    assert requests.post(f"{URLS['api']}/api/auth/tokens", headers=h, json={"name": "x"}, timeout=10).status_code == 403
    listed = owner.get("/auth/tokens").json()["data"]
    assert any(t["id"] == tok["id"] and t["last_used_at"] for t in listed) and "token" not in listed[0]
    assert owner.delete(f"/auth/tokens/{tok['id']}").status_code == 200
    assert requests.get(f"{URLS['api']}/api/projects", headers=h, timeout=10).status_code == 401
    assert requests.get(f"{URLS['api']}/api/projects", headers={"Authorization": "Bearer odb_pat_forged"}, timeout=10).status_code == 401


@pytest.fixture()
def cli(tmp_path, owner):
    tsx = CLI / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not tsx.exists():
        pytest.skip(f"run `npm install` in {CLI} first")
    token = owner.post("/auth/tokens", json={"name": "cli-test", "expires_in_days": 1}).json()["token"]
    env = {**os.environ, "ODB_CONFIG": str(tmp_path / "cli.json"), "ODB_API_URL": URLS["api"], "ODB_TOKEN": token, "NO_COLOR": "1"}
    base = [shutil.which("node") or "node", str(tsx), str(CLI / "src" / "cli.ts")]

    def run(*args, ok=True):
        p = subprocess.run(base + list(args), env=env, capture_output=True, text=True, timeout=120, cwd=tmp_path)
        if ok:
            assert p.returncode == 0, f"odb {' '.join(args)}\nstdout:{p.stdout}\nstderr:{p.stderr}"
        return p
    run.dir = tmp_path
    return run


def test_cli_push_pull_reset(cli, proj):
    cli("init", "--github")
    assert (cli.dir / "odb" / "migrations").is_dir() and (cli.dir / ".github" / "workflows" / "odb-migrations.yml").exists()
    f1 = Path(json.loads(cli("--json", "migration", "new", "create items").stdout)["file"])
    # exact bytes (write_text would translate newlines on Windows): a CRLF checkout …
    f1.write_bytes(b"create table items (id int primary key, name text);\r\n")
    assert "Applying" in cli("db", "push", proj.id).stdout
    assert "Up to date" in cli("db", "push", proj.id).stdout
    assert "items" in tables(proj)

    # dry run of a broken migration: reported, nothing applied or recorded
    import time; time.sleep(1.1)
    f2 = Path(json.loads(cli("--json", "migration", "new", "broken").stdout)["file"])
    f2.write_bytes(b"alter table missing add column x int;\n")
    p = cli("db", "push", proj.id, "--dry-run", ok=False)
    assert p.returncode != 0 and "missing" in (p.stdout + p.stderr)
    f2.unlink()

    # editing an applied migration is refused
    f1.write_bytes(b"create table items (id int primary key);\n")
    p = cli("db", "push", proj.id, ok=False)
    assert "edited" in (p.stdout + p.stderr)
    # … and an LF checkout of the same file have the same checksum
    f1.write_bytes(b"create table items (id int primary key, name text);\n")

    listed = json.loads(cli("--json", "migration", "list", proj.id).stdout)
    assert [m["applied"] != "pending" for m in listed] == [True]

    # pull: remote schema into a new file, recorded as applied → push stays up to date
    time.sleep(1.1)
    pulled = Path(json.loads(cli("--json", "db", "pull", proj.id).stdout)["file"])
    assert "CREATE TABLE items" in pulled.read_text()
    assert "Up to date" in cli("db", "push", proj.id).stdout
    pulled.unlink()
    cli("migration", "repair", proj.id, pulled.name.split("_")[0], "--status", "reverted")

    # reset: empty the schema, replay migrations, run seed.sql
    (cli.dir / "odb" / "seed.sql").write_bytes(b"insert into items values (1, 'seeded');\n")
    proj.sql("insert into items values (2, 'temp')")
    assert cli("db", "reset", proj.id, "--confirm", "wrong", ok=False).returncode != 0
    cli("db", "reset", proj.id, "--confirm", proj.slug)
    rows = proj.sql("select id, name from items order by id")["data"]
    assert rows == [{"id": 1, "name": "seeded"}]
