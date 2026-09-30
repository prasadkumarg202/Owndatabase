"""Secrets vault (docs/vault.md): secrets are sealed at rest, services read them only through the
vault with their own token and policy, keys rotate without losing secrets, and every access is audited.

Some checks read the database or call the internal endpoint from inside a container (docker CLI);
those are skipped without docker."""
import json
import shutil
import subprocess
import time
import uuid

import pytest
import requests
from odb import BASE, URLS, create_project, wait_until

PG = "owndatabase-postgres"


def docker(*args, timeout=60) -> str:
    if not shutil.which("docker"):
        pytest.skip("needs the docker CLI")
    p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    assert p.returncode == 0, p.stderr
    return p.stdout


def psql(query: str) -> str:
    env = docker("exec", PG, "printenv", "POSTGRES_PASSWORD").strip()
    return docker("exec", "-e", f"PGPASSWORD={env}", PG, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "owndatabase", "-tAc", query).strip()


def reveal(container: str, token_env: str | None, body: dict) -> tuple[int, dict]:
    """POST /api/internal/vault/reveal from inside a service container (the gateway blocks it)."""
    js = (
        "const t=process.env.VAULT_TOKEN;"
        f"fetch('http://control-api:3000/api/internal/vault/reveal',{{method:'POST',"
        f"headers:Object.assign({{'content-type':'application/json'}},{'t?{authorization:`Bearer ${t}`}:{}' if token_env else '{}'}),"
        f"body:{json.dumps(json.dumps(body))}}})"
        ".then(async r=>console.log(JSON.stringify({s:r.status,b:await r.json()})))"
    )
    out = docker("exec", container, "node", "-e", js)
    r = json.loads(out.strip().splitlines()[-1])
    return r["s"], r["b"]


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "vault")
    r = owner.put(f"/projects/{p.id}/auth-config", json={
        "site_url": "http://app.example.com",
        "providers": {"google": {"enabled": True, "client_id": "g-client", "client_secret": "google-secret-value"}},
        "captcha": {"enabled": False, "provider": "turnstile", "secret": "captcha-secret-value"},
    })
    assert r.status_code == 200, r.text
    assert owner.post("/secrets", json={"project_id": p.id, "name": "VAULT_TEST", "value": "fn-secret-value"}).status_code == 201
    r = owner.post(f"/projects/{p.id}/functions", json={
        "slug": "show-secret", "verify_jwt": False,
        "code": "export default async (req) => ({ status: 200, body: { v: req.env.VAULT_TEST ?? null } })"})
    assert r.status_code == 201, r.text
    return p


def fn_secret(p):
    r = requests.post(f"{URLS['functions']}/v1/{p.id}/show-secret", headers={"apikey": p.anon_key}, json={}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["v"]


def test_secrets_are_sealed_at_rest(proj):
    raw = psql(f"select settings->'auth'->'providers'->'google'->>'client_secret' || '|' || (settings->'auth'->'captcha'->>'secret') from control_plane.projects where id = '{proj.id}'")
    assert "google-secret-value" not in raw and "captcha-secret-value" not in raw
    assert all(v.startswith("vault:v1:") for v in raw.split("|")), raw
    fn = psql(f"select convert_from(value_encrypted, 'UTF8') from control_plane.secrets where project_id = '{proj.id}' and is_active")
    assert fn.startswith("vault:v1:") and "fn-secret-value" not in fn
    pw = psql(f"select metadata->>'db_password_enc' from control_plane.projects where id = '{proj.id}'")
    assert pw.startswith("vault:v1:")
    # the API never returns them
    cfg = proj.owner.get(f"/projects/{proj.id}/auth-config").json()
    assert cfg["providers"]["google"]["client_secret"] == "••••••••" and cfg["captcha"]["secret"] == "••••••••"
    assert all("value" not in s for s in proj.owner.get(f"/secrets?project_id={proj.id}").json()["data"])


def test_ciphertext_is_bound_to_its_project_and_field(proj, owner):
    other = create_project(owner, "vault other")
    owner.put(f"/projects/{other.id}/auth-config", json={"providers": {"google": {"enabled": True, "client_id": "x", "client_secret": "other-secret"}}})
    sealed = psql(f"select settings->'auth'->'providers'->'google'->>'client_secret' from control_plane.projects where id = '{proj.id}'")
    # copy project A's sealed value into project B, and into another field of A
    psql(f"update control_plane.projects set settings = jsonb_set(settings, '{{auth,providers,google,client_secret}}', to_jsonb('{sealed}'::text)) where id = '{other.id}'")
    status, body = reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": other.id, "kind": "auth"})
    assert status >= 500 or "auth.providers.google.client_secret" not in body.get("secrets", {}), body
    psql(f"update control_plane.projects set settings = jsonb_set(settings, '{{auth,captcha,secret}}', to_jsonb('{sealed}'::text)) where id = '{proj.id}'")
    status, body = reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": proj.id, "kind": "auth"})
    assert status >= 500, body
    # restore
    proj.owner.put(f"/projects/{proj.id}/auth-config", json={"captcha": {"secret": "captcha-secret-value"}})


def test_services_read_only_what_their_policy_allows(proj):
    status, body = reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": proj.id, "kind": "auth"})
    assert status == 200 and body["secrets"]["auth.providers.google.client_secret"] == "google-secret-value", body
    assert reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": proj.id, "kind": "function_secrets"})[0] == 403
    assert reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": proj.id, "kind": "db_password"})[0] == 403
    assert reveal("owndatabase-api", "VAULT_TOKEN", {"project_id": proj.id, "kind": "auth"})[0] == 403
    status, body = reveal("owndatabase-api", "VAULT_TOKEN", {"project_id": proj.id, "kind": "function_secrets"})
    assert status == 200 and body["secrets"] == {"VAULT_TEST": "fn-secret-value"}
    assert reveal("owndatabase-queue-worker", "VAULT_TOKEN", {"project_id": proj.id, "kind": "db_password"})[0] == 200
    # no token / a made-up one
    assert reveal("owndatabase-auth", None, {"project_id": proj.id, "kind": "auth"})[0] == 401
    # the gateway does not expose it at all
    r = requests.post(f"{BASE}/api/internal/vault/reveal", json={"project_id": proj.id, "kind": "auth"}, timeout=10)
    assert r.status_code == 404
    # services hold no master key
    for c in ("owndatabase-api", "owndatabase-queue-worker", "owndatabase-auth"):
        env = docker("exec", c, "printenv")
        assert "VAULT_MASTER_KEYS" not in env and "VAULT_SERVICE_TOKENS" not in env
    # only the control API holds the platform's encryption key
    for c in ("owndatabase-api", "owndatabase-queue-worker", "owndatabase-auth", "owndatabase-backup-worker"):
        assert "SECRET_ENCRYPTION_KEY" not in docker("exec", c, "printenv"), c


def test_secrets_work_end_to_end(proj):
    assert fn_secret(proj) == "fn-secret-value"
    # a new value reaches functions (the cache is dropped on change)
    assert proj.owner.post("/secrets", json={"project_id": proj.id, "name": "VAULT_TEST", "value": "fn-secret-2"}).status_code == 201
    wait_until(lambda: fn_secret(proj) == "fn-secret-2", timeout=10, message="new function secret")


def test_project_key_rotation(proj):
    before = proj.owner.get(f"/projects/{proj.id}/vault").json()
    v0 = before["keys"][0]["version"]
    r = proj.owner.post(f"/projects/{proj.id}/vault/rotate")
    assert r.status_code == 200, r.text
    assert r.json()["version"] == v0 + 1 and r.json()["secrets"] >= 4
    info = proj.owner.get(f"/projects/{proj.id}/vault").json()
    assert info["keys"][0]["status"] == "active" and info["keys"][1]["status"] == "retired"
    new_dek = psql(f"select id from control_plane.vault_keys where scope = '{proj.id}' and status = 'active'")
    sealed = psql(f"select settings->'auth'->'providers'->'google'->>'client_secret' from control_plane.projects where id = '{proj.id}'")
    assert sealed.startswith(f"vault:v1:{new_dek}:")
    # everything still decrypts
    status, body = reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": proj.id, "kind": "auth"})
    assert body["secrets"]["auth.providers.google.client_secret"] == "google-secret-value"
    assert fn_secret(proj) == "fn-secret-2"
    actions = [e["action"] for e in info["audit"]]
    assert "rotate_project_key" in actions and "reveal" in actions


def test_rotation_needs_admin_role(owner, proj):
    from odb import signup_platform_user
    stranger = signup_platform_user("vault-stranger")
    assert stranger.post(f"/projects/{proj.id}/vault/rotate").status_code in (403, 404)
    assert stranger.get("/admin/vault").status_code == 403


def test_admin_status_and_master_key_rotation(platform_admin):
    s = platform_admin.get("/admin/vault").json()
    assert s["active_master_key"] and s["active_master_key"] in s["configured_master_keys"]
    assert s["not_in_vault_format"] == {"function_secrets": 0, "webhook_secrets": 0, "db_passwords": 0, "mfa_seeds": 0}
    r = platform_admin.post("/admin/vault/rotate-master-key")
    assert r.status_code == 200 and r.json()["rewrapped"] == 0  # already all under the active key
    audit = platform_admin.get("/admin/vault/audit?limit=20").json()["data"]
    assert audit and {"actor", "action", "at"} <= set(audit[0])


def test_branch_gets_its_own_sealed_copy(proj):
    r = proj.owner.post(f"/projects/{proj.id}/branches", json={"name": f"v{uuid.uuid4().hex[:6]}"})
    assert r.status_code == 201, r.text
    branch = r.json()["id"]
    sealed = psql(f"select settings->'auth'->'providers'->'google'->>'client_secret' from control_plane.projects where id = '{branch}'")
    parent = psql(f"select settings->'auth'->'providers'->'google'->>'client_secret' from control_plane.projects where id = '{proj.id}'")
    assert sealed.startswith("vault:v1:") and sealed.split(":")[2] != parent.split(":")[2]
    status, body = reveal("owndatabase-auth", "VAULT_TOKEN", {"project_id": branch, "kind": "auth"})
    assert status == 200 and body["secrets"]["auth.providers.google.client_secret"] == "google-secret-value"


def test_deleting_a_project_destroys_its_keys(owner):
    p = create_project(owner, "vault delete")
    owner.put(f"/projects/{p.id}/auth-config", json={"providers": {"google": {"enabled": True, "client_id": "x", "client_secret": "gone"}}})
    assert psql(f"select count(*) from control_plane.vault_keys where scope = '{p.id}'") == "1"
    slug = owner.get(f"/projects/{p.id}").json()["slug"]
    assert owner.delete(f"/projects/{p.id}?confirm={slug}").status_code == 200
    assert psql(f"select count(*) from control_plane.vault_keys where scope = '{p.id}'") == "0"
