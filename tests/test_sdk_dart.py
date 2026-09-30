"""The official Supabase Dart client (the core of supabase_flutter) against an OwnDatabase project,
run in a dart:stable container (tests/supabase_dart). Needs the docker CLI; the container reaches the
stack at host.docker.internal."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from odb import create_project

DIR = Path(__file__).resolve().parent / "supabase_dart"
HOST = os.environ.get("ODB_WEBHOOK_HOST", "host.docker.internal")


@pytest.fixture(scope="module")
def proj(owner):
    if not shutil.which("docker"):
        pytest.skip("needs the docker CLI")
    p = create_project(owner, "supabase-dart")
    p.sql("""
        create table dart_items (id int primary key, name text, price numeric);
        insert into dart_items values (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 30);
        create table dart_notes (id bigint generated always as identity primary key, body text, owner uuid default auth.uid());
        alter table dart_notes enable row level security;
        create policy own on dart_notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
        create function dart_add(a int, b int) returns int language sql as $$ select a + b $$;
    """)
    assert p.owner.post(f"/projects/{p.id}/tables/dart_items/realtime", json={"enabled": True}).status_code == 200
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "dart", "public": True}).status_code in (200, 201)
    r = p.owner.post(f"/projects/{p.id}/functions", json={"slug": "dart-echo", "verify_jwt": False,
        "code": "export default async (req) => ({ status: 200, body: { got: (await req.json()).n } })"})
    assert r.status_code == 201, r.text
    return p


@pytest.mark.slow
def test_supabase_dart(proj):
    cmd = ["docker", "run", "--rm", "-v", f"{DIR}:/app", "-v", "odb-dart-pub-cache:/root/.pub-cache", "-w", "/app",
           "-e", f"ODB_URL=http://{HOST}/p/{proj.id}", "-e", f"ODB_ANON_KEY={proj.anon_key}", "-e", f"ODB_SERVICE_KEY={proj.service_key}",
           "dart:stable", "sh", "-c", "dart pub get >/dev/null && dart run bin/compat.dart"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=900, env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    assert p.returncode == 0 and "ALL PASSED" in p.stdout, p.stdout[-6000:] + p.stderr[-3000:]
