"""The JavaScript SDK (platform/sdk-js) against the running stack: node --test with a prepared project."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from odb import BASE, create_project

SDK = Path(__file__).resolve().parents[1] / "platform" / "sdk-js"


@pytest.fixture(scope="module")
def sdk_project(owner):
    if not (SDK / "dist" / "index.js").exists():
        pytest.skip("build the SDK first: cd platform/sdk-js && npm install && npm run build")
    p = create_project(owner, "SDK test")
    p.sql("""
        create table sdk_items (id int primary key, name text, price numeric);
        insert into sdk_items values (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 30);
        grant select on sdk_items to anon;
        create table sdk_notes (id bigint generated always as identity primary key, body text,
                                user_id uuid not null default auth.uid());
        alter table sdk_notes enable row level security;
        create policy own on sdk_notes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
        grant select, insert on sdk_notes to authenticated;
        grant select on sdk_notes to anon;
        create function sdk_add(a int, b int) returns int language sql as $$ select a + b $$;
    """)
    assert p.owner.post(f"/projects/{p.id}/tables/sdk_items/realtime", json={"enabled": True}).status_code == 200
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "sdk-files", "public": True}).status_code in (200, 201)
    r = p.owner.post(f"/projects/{p.id}/functions", json={
        "slug": "sdk-echo", "verify_jwt": False,
        "code": "export default async (req) => ({ status: 200, body: { got: (await req.json()).n } })"})
    assert r.status_code == 201, r.text
    return p


def test_js_sdk(sdk_project):
    env = {**os.environ, "ODB_URL": BASE, "ODB_PROJECT_ID": sdk_project.id,
           "ODB_ANON_KEY": sdk_project.anon_key, "ODB_SERVICE_KEY": sdk_project.service_key}
    p = subprocess.run([shutil.which("node") or "node", "--test", "--test-reporter=spec", "test/integration.test.mjs"], cwd=SDK, env=env,
                       capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, p.stdout[-6000:] + p.stderr[-2000:]
    assert "fail 0" in p.stdout and "skipped 0" in p.stdout, p.stdout[-2000:]
