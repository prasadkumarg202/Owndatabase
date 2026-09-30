"""Compatibility: the real @supabase/supabase-js (tests/supabase_js) against an OwnDatabase project,
using the /p/<projectId> URL prefix (createClient('http://host/p/<id>', key))."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from odb import BASE, create_project

DIR = Path(__file__).resolve().parent / "supabase_js"


@pytest.fixture(scope="module")
def compat_project(owner):
    if not (DIR / "node_modules" / "@supabase" / "supabase-js").exists():
        pytest.skip("run `npm install` in tests/supabase_js")
    p = create_project(owner, "supabase-js compat")
    p.sql("""
        create table compat_items (id int primary key, name text, price numeric);
        insert into compat_items values (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 30);
        create table compat_notes (id bigint generated always as identity primary key, body text, owner uuid default auth.uid());
        alter table compat_notes enable row level security;
        create policy own on compat_notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
        create function compat_add(a int, b int) returns int language sql as $$ select a + b $$;
    """)
    assert p.owner.post(f"/projects/{p.id}/tables/compat_items/realtime", json={"enabled": True}).status_code == 200
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "compat", "public": True}).status_code in (200, 201)
    r = p.owner.post(f"/projects/{p.id}/functions", json={"slug": "compat-echo", "verify_jwt": False,
        "code": "export default async (req) => ({ status: 200, body: { got: (await req.json()).n } })"})
    assert r.status_code == 201, r.text
    return p


def test_supabase_js(compat_project):
    env = {**os.environ, "ODB_URL": BASE, "ODB_PROJECT_ID": compat_project.id,
           "ODB_ANON_KEY": compat_project.anon_key, "ODB_SERVICE_KEY": compat_project.service_key}
    p = subprocess.run([shutil.which("node") or "node", "--test", "--test-reporter=spec", "compat.test.mjs"], cwd=DIR, env=env,
                       capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, p.stdout[-8000:] + p.stderr[-2000:]
    assert "fail 0" in p.stdout and "skipped 0" in p.stdout, p.stdout[-2000:]
