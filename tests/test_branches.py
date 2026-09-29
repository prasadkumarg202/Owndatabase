"""Branches: copies of a project's schema (and data), own keys, merging migrations back."""
import pytest
import requests
from odb import URLS, create_project


def migrate(p, version, sql, name="m"):
    r = p.owner.post(f"/projects/{p.id}/migrations", json={"version": version, "name": name, "sql": sql})
    assert r.status_code == 201, r.text


@pytest.fixture(scope="module")
def parent(owner):
    p = create_project(owner, "Branch parent")
    migrate(p, "20260101000000", """
        create table customers (id int primary key, name text not null);
        create table audit_who (who text, at timestamptz default now());
        create function log_who() returns trigger language plpgsql as $$
          begin insert into audit_who (who) values (current_user); return new; end $$;
        create trigger customers_who after insert on customers for each row execute function log_who();
        grant select on customers to anon;
    """, "base")
    p.sql("insert into customers values (1, 'Asha'), (2, 'Ravi')")
    # a database webhook adds a trigger calling a platform function; branching must cope
    p.owner.post(f"/projects/{p.id}/webhooks", json={"name": "h", "table": "customers", "events": ["insert"], "url": "https://example.com/h"})
    p.owner.post(f"/projects/{p.id}/functions", json={"slug": "hello", "code": "export default () => 'hi'", "verify_jwt": False})
    return p


def branch(parent, name, **kw):
    r = parent.owner.post(f"/projects/{parent.id}/branches", json={"name": name, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def sql(owner, pid, q, ok=True):
    r = owner.post(f"/projects/{pid}/execute", json={"query": q})
    if ok:
        assert r.status_code == 200, r.text
    return r.json()


def test_branch_with_data_is_a_separate_project(parent):
    b = branch(parent, "preview", with_data=True)
    assert b["parent_project_id"] == parent.id and b["branch_name"] == "preview" and b["id"] != parent.id
    rows = sql(parent.owner, b["id"], "select id, name from customers order by id")["data"]
    assert rows == [{"id": 1, "name": "Asha"}, {"id": 2, "name": "Ravi"}]
    # the copy ran as the branch's own role: triggers never ran as the platform superuser
    who = {r["who"] for r in sql(parent.owner, b["id"], "select distinct who from audit_who")["data"]}
    assert who and all(w.endswith("_owner") and w != "postgres" for w in who), who

    # own keys: the parent's key does not open the branch, the branch's does
    assert requests.get(f"{URLS['rest']}/v1/{b['id']}/customers", headers={"apikey": parent.anon_key}, timeout=10).status_code == 401
    assert requests.get(f"{URLS['rest']}/v1/{b['id']}/customers", headers={"apikey": b["api_keys"]["anon"]}, timeout=10).json()[0]["name"] == "Asha"
    # functions come along, and so does the migration history
    assert [f["slug"] for f in parent.owner.get(f"/projects/{b['id']}/functions").json()["data"]] == ["hello"]
    assert [m["version"] for m in parent.owner.get(f"/projects/{b['id']}/migrations").json()["data"]] == ["20260101000000"]
    # writes in the branch do not touch the parent
    sql(parent.owner, b["id"], "delete from customers")
    assert len(parent.sql("select * from customers")["data"]) == 2


def test_branch_without_data_and_merge(parent):
    b = branch(parent, "feature-x")
    assert sql(parent.owner, b["id"], "select count(*)::int n from customers")["data"][0]["n"] == 0
    migrate(type("P", (), {"owner": parent.owner, "id": b["id"]}), "20260201000000", "alter table customers add column email text;", "add_email")
    listed = {x["branch_name"]: x for x in parent.owner.get(f"/projects/{parent.id}/branches").json()["data"]}
    assert listed["feature-x"]["unmerged_migrations"] == 1

    r = parent.owner.post(f"/projects/{parent.id}/branches/{b['id']}/merge", json={"dry_run": True})
    assert r.status_code == 200 and r.json()["applied"] == ["20260201000000"], r.text
    assert "email" not in [c["name"] for c in parent.owner.get(f"/projects/{parent.id}/tables/customers").json()["data"]["columns"]]
    r = parent.owner.post(f"/projects/{parent.id}/branches/{b['id']}/merge", json={})
    assert r.json()["applied"] == ["20260201000000"], r.text
    assert "email" in [c["name"] for c in parent.owner.get(f"/projects/{parent.id}/tables/customers").json()["data"]["columns"]]
    listed = {x["branch_name"]: x for x in parent.owner.get(f"/projects/{parent.id}/branches").json()["data"]}
    assert listed["feature-x"]["unmerged_migrations"] == 0
    assert parent.owner.post(f"/projects/{parent.id}/branches/{b['id']}/merge", json={}).json()["applied"] == []


def test_validation_and_delete(parent, owner):
    assert parent.owner.post(f"/projects/{parent.id}/branches", json={"name": "Bad Name"}).status_code == 400
    b = branch(parent, "temp")
    assert parent.owner.post(f"/projects/{parent.id}/branches", json={"name": "temp"}).status_code == 409
    assert parent.owner.post(f"/projects/{b['id']}/branches", json={"name": "nested"}).status_code == 400
    assert parent.owner.delete(f"/projects/{parent.id}/branches/{b['id']}").status_code == 200
    assert parent.owner.get(f"/projects/{b['id']}").status_code == 404

    # deleting a project deletes its branches
    p2 = create_project(owner, "Parent two")
    b2 = branch(p2, "one")
    assert owner.delete(f"/projects/{p2.id}?confirm={p2.slug}").status_code == 200
    assert owner.get(f"/projects/{b2['id']}").status_code == 404


def test_cli_branches(parent, tmp_path):
    import json, os, shutil, subprocess
    from pathlib import Path
    cli_dir = Path(__file__).resolve().parents[1] / "platform" / "cli"
    tsx = cli_dir / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not tsx.exists():
        pytest.skip("run npm install in platform/cli")
    token = parent.owner.post("/auth/tokens", json={"name": "branches-cli", "expires_in_days": 1}).json()["token"]
    env = {**os.environ, "ODB_CONFIG": str(tmp_path / "c.json"), "ODB_API_URL": URLS["api"], "ODB_TOKEN": token, "NO_COLOR": "1"}
    odb = lambda *a: subprocess.run([shutil.which("node") or "node", str(tsx), str(cli_dir / "src" / "cli.ts"), *a], env=env, capture_output=True, text=True, timeout=120, cwd=tmp_path)
    r = odb("--json", "branches", "create", parent.id, "cli-branch")
    assert r.returncode == 0, r.stderr
    bid = json.loads(r.stdout)["id"]
    assert any(b["id"] == bid for b in json.loads(odb("--json", "branches", "list", parent.id).stdout))
    assert odb("branches", "delete", parent.id, bid).returncode == 0
    odb("init", "--github")
    assert (tmp_path / ".github" / "workflows" / "odb-preview-branches.yml").exists()
