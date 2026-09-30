"""The official Supabase Swift client (supabase-swift) against an OwnDatabase project, built and run in a
swift:6.0 Linux container (tests/supabase_swift). Needs the docker CLI; the first run compiles the package
(several minutes; the build cache is kept in a docker volume)."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from odb import create_project

DIR = Path(__file__).resolve().parent / "supabase_swift"
HOST = os.environ.get("ODB_WEBHOOK_HOST", "host.docker.internal")


@pytest.fixture(scope="module")
def proj(owner):
    if not shutil.which("docker"):
        pytest.skip("needs the docker CLI")
    p = create_project(owner, "supabase-swift")
    p.sql("""
        create table swift_items (id int primary key, name text, price numeric);
        insert into swift_items values (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 30);
        create table swift_notes (id bigint generated always as identity primary key, body text, owner uuid default auth.uid());
        alter table swift_notes enable row level security;
        create policy own on swift_notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
        create function swift_add(a int, b int) returns int language sql as $$ select a + b $$;
    """)
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "swift", "public": False}).status_code in (200, 201)
    r = p.owner.post(f"/projects/{p.id}/functions", json={"slug": "swift-echo", "verify_jwt": False,
        "code": "export default async (req) => ({ status: 200, body: { got: (await req.json()).n } })"})
    assert r.status_code == 201, r.text
    return p


@pytest.mark.slow
def test_supabase_swift(proj):
    cmd = ["docker", "run", "--rm", "-v", f"{DIR}:/src:ro", "-v", "odb-swift-build:/build", "-w", "/build",
           "-e", f"ODB_URL=http://{HOST}/p/{proj.id}", "-e", f"ODB_ANON_KEY={proj.anon_key}", "-e", f"ODB_SERVICE_KEY={proj.service_key}",
           "swift:6.0-jammy", "sh", "-c",
           # build in a volume (the source is read-only; .build stays between runs)
           "mkdir -p pkg && cp -r /src/Package.swift /src/Sources pkg/ && cd pkg && swift build -c debug 2>&1 | tail -20 && ./.build/debug/Compat"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=2400, env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    assert p.returncode == 0 and "ALL PASSED" in p.stdout, p.stdout[-6000:] + p.stderr[-3000:]
