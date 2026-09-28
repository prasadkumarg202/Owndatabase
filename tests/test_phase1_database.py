"""Phase 1 — projects, schema provisioning, table editor, SQL editor, EXPLAIN, stats, extensions, roles, RLS policies."""
import uuid
import pytest
from odb import signup_platform_user, create_project


def test_project_provisioned(project):
    p = project.owner.get(f"/projects/{project.id}").json()
    assert p["status"] == "active"
    assert p["db_schema"] == project.schema
    assert p["endpoints"]["rest_url"].endswith(f"/rest/v1/{project.id}")
    schemas = project.owner.get(f"/projects/{project.id}/schemas").json()["data"]
    assert schemas[0]["name"] == project.schema


def test_create_table_and_describe(project):
    r = project.owner.post(f"/projects/{project.id}/tables", json={
        "name": "products",
        "columns": [
            {"name": "id", "type": "bigint generated always as identity", "primary_key": True},
            {"name": "name", "type": "text", "nullable": False},
            {"name": "price", "type": "numeric(10,2)", "default": "0"},
            {"name": "tags", "type": "text[]"},
            {"name": "meta", "type": "jsonb", "default": "'{}'::jsonb"},
        ],
    })
    assert r.status_code == 201, r.text
    t = project.owner.get(f"/projects/{project.id}/tables/products").json()["data"]
    names = [c["name"] for c in t["columns"]]
    assert names == ["id", "name", "price", "tags", "meta"]
    assert next(c for c in t["columns"] if c["name"] == "id")["is_primary_key"] is True
    assert "CREATE TABLE" in t["ddl"]
    listed = [x["name"] for x in project.owner.get(f"/projects/{project.id}/tables").json()["data"]]
    assert "products" in listed


def test_invalid_names_and_types_rejected(project):
    bad = project.owner.post(f"/projects/{project.id}/tables", json={"name": "x; drop table y", "columns": [{"name": "a", "type": "text"}]})
    assert bad.status_code == 400
    bad = project.owner.post(f"/projects/{project.id}/tables", json={"name": "ok", "columns": [{"name": "a", "type": "text); drop table products; --"}]})
    assert bad.status_code == 400


def test_alter_table_actions(project):
    base = f"/projects/{project.id}/tables/products"
    assert project.owner.patch(base, json={"action": "add_column", "column": {"name": "stock", "type": "integer", "default": "0"}}).status_code == 200
    assert project.owner.patch(base, json={"action": "rename_column", "column_name": "stock", "new_name": "quantity"}).status_code == 200
    assert project.owner.patch(base, json={"action": "add_index", "columns": ["name"], "unique": True}).status_code == 200
    assert project.owner.patch(base, json={"action": "set_nullable", "column_name": "quantity", "nullable": False}).status_code == 200
    t = project.owner.get(base).json()["data"]
    assert any("quantity" == c["name"] and c["nullable"] is False for c in t["columns"])
    assert any("UNIQUE" in i["definition"] for i in t["indexes"])
    # old camelCase payload still accepted
    assert project.owner.patch(base, json={"action": "add_column", "columnName": "legacy", "type": "text"}).status_code == 200
    assert project.owner.patch(base, json={"action": "drop_column", "column_name": "legacy"}).status_code == 200


def test_row_crud_via_table_editor(project):
    base = f"/projects/{project.id}/tables/products/rows"
    r = project.owner.post(base, json={"name": "Widget", "price": "9.99", "tags": ["a", "b"], "quantity": "5"})
    assert r.status_code == 201, r.text
    row = r.json()["data"]
    assert row["name"] == "Widget" and row["quantity"] == 5
    r = project.owner.patch(base, json={"match": {"id": row["id"]}, "values": {"price": "12.50"}})
    assert r.status_code == 200 and r.json()["data"]["price"] == "12.50"
    rows = project.owner.get(f"{base}?limit=10&order=id&direction=desc").json()
    assert rows["count"] >= 1 and rows["primary_key"] == ["id"]
    assert project.owner.delete(base, json={"match": {"id": row["id"]}}).json()["deleted"] == 1


def test_sql_editor_multi_statement(project):
    res = project.sql("create table if not exists sql_t (id int primary key, v text); insert into sql_t values (1,'a'),(2,'b') on conflict do nothing; select * from sql_t order by id")
    assert res["statements"] >= 2  # DDL statements do not produce a result set
    assert res["columns"] == ["id", "v"]
    assert [r["v"] for r in res["data"]] == ["a", "b"]


def test_sql_editor_reports_errors_and_history(project):
    r = project.owner.post(f"/projects/{project.id}/execute", json={"query": "select * from definitely_missing"})
    assert r.status_code == 400
    assert r.json()["code"] == "42P01"
    hist = project.owner.get(f"/projects/{project.id}/query-history").json()["data"]
    assert any("definitely_missing" in h["query"] and h["error"] for h in hist)


def test_sql_editor_is_confined_to_project(project):
    """The SQL editor runs as the project owner role, not as the platform superuser."""
    for q in [
        "select * from control_plane.platform_users",
        "reset role; select * from control_plane.api_keys",
        "set role postgres",
        "select * from auth.users",
        "create extension if not exists hstore",
    ]:
        r = project.owner.post(f"/projects/{project.id}/execute", json={"query": q})
        assert r.status_code == 400, f"{q} -> {r.status_code} {r.text}"
    other = create_project(project.owner, "Other project")
    other.sql("create table secret_stuff (x int)")
    r = project.owner.post(f"/projects/{project.id}/execute", json={"query": f"select * from {other.schema}.secret_stuff"})
    assert r.status_code == 400 and r.json()["code"] == "42501"


def test_read_only_execution(project):
    r = project.owner.post(f"/projects/{project.id}/execute", json={"query": "insert into sql_t values (99,'x')", "read_only": True})
    assert r.status_code == 400 and "read-only" in r.json()["message"]


def test_explain_analyze_rolls_back(project):
    before = project.sql("select count(*)::int as n from sql_t")["data"][0]["n"]
    r = project.owner.post(f"/projects/{project.id}/explain", json={"query": "delete from sql_t", "analyze": True})
    assert r.status_code == 200, r.text
    assert "Delete" in r.json()["plan"] or "ModifyTable" in r.json()["plan"]
    assert r.json()["execution_time_ms"] is not None
    after = project.sql("select count(*)::int as n from sql_t")["data"][0]["n"]
    assert before == after


def test_database_stats(project):
    s = project.owner.get(f"/projects/{project.id}/stats").json()["data"]
    assert s["max_connections"] > 0
    assert 0 <= s["cache_hit_ratio"] <= 1
    assert any(t["table"] == "products" for t in s["tables"])
    assert isinstance(s["slow_queries"], list)


def test_extensions(project):
    exts = {e["name"]: e for e in project.owner.get(f"/projects/{project.id}/extensions").json()["data"]}
    assert exts["pgcrypto"]["installed"] is True
    r = project.owner.post(f"/projects/{project.id}/extensions", json={"name": "citext"})
    assert r.status_code == 201, r.text
    exts = {e["name"]: e for e in project.owner.get(f"/projects/{project.id}/extensions").json()["data"]}
    assert exts["citext"]["installed"] is True
    assert project.owner.post(f"/projects/{project.id}/extensions", json={"name": "plpython3u"}).status_code == 400


def test_custom_roles(project):
    r = project.owner.post(f"/projects/{project.id}/roles", json={"name": "reporting"})
    assert r.status_code == 201, r.text
    roles = {x["name"]: x for x in project.owner.get(f"/projects/{project.id}/roles").json()["data"]}
    assert f"{project.schema}_reporting" in roles
    assert roles[f"{project.schema}_owner"]["kind"] == "owner"
    assert project.owner.delete(f"/projects/{project.id}/roles/{project.schema}_reporting").status_code == 200
    assert project.owner.delete(f"/projects/{project.id}/roles/{project.schema}_owner").status_code == 400


def test_rls_policy_management(project):
    project.sql("create table if not exists pol_t (id int primary key, user_id uuid)")
    r = project.owner.post(f"/projects/{project.id}/policies", json={
        "table": "pol_t", "name": "own rows", "command": "ALL", "roles": ["authenticated"],
        "using": "user_id = auth.uid()", "with_check": "user_id = auth.uid()",
    })
    assert r.status_code == 201, r.text
    t = project.owner.get(f"/projects/{project.id}/tables/pol_t").json()["data"]
    assert t["rls_enabled"] is True and t["policies"][0]["name"] == "own rows"
    assert project.owner.delete(f"/projects/{project.id}/policies/pol_t/own rows").status_code == 200
    assert project.owner.get(f"/projects/{project.id}/policies?table=pol_t").json()["data"] == []


def test_schema_dump(project):
    ddl = project.owner.get(f"/projects/{project.id}/schema-dump").json()["ddl"]
    assert f'"{project.schema}"."products"' in ddl


def test_pause_resume_and_delete_project(owner):
    p = create_project(owner)
    assert owner.post(f"/projects/{p.id}/pause").json()["status"] == "paused"
    r = p.rest("GET", "anything")
    assert r.status_code == 503
    assert owner.post(f"/projects/{p.id}/resume").json()["status"] == "active"
    assert owner.delete(f"/projects/{p.id}").status_code == 400  # needs confirmation
    assert owner.delete(f"/projects/{p.id}?confirm={p.slug}").status_code == 200
    assert owner.get(f"/projects/{p.id}").status_code == 404
    r = owner.post("/projects", json={"name": "x"})  # slug derived from name
    assert r.status_code in (201, 409)


def test_connection_details(project):
    c = project.owner.get(f"/projects/{project.id}/connection").json()
    assert c["user"] == f"{project.schema}_owner"
    assert c["connection_string"].startswith("postgres")
