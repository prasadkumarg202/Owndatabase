"""The official Supabase Python client (supabase-py) against an OwnDatabase project, through the
/p/<projectId> URL: database, RPC, auth, RLS, storage, functions and realtime."""
import asyncio
import time
import uuid

import pytest
from odb import BASE, create_project

supabase = pytest.importorskip("supabase")


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "supabase-py")
    p.sql("""
        create table py_items (id int primary key, name text, price numeric);
        insert into py_items values (1, 'alpha', 10), (2, 'beta', 20), (3, 'gamma', 30);
        create table py_notes (id bigint generated always as identity primary key, body text, owner uuid default auth.uid());
        alter table py_notes enable row level security;
        create policy own on py_notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
        create function py_add(a int, b int) returns int language sql as $$ select a + b $$;
    """)
    assert p.owner.post(f"/projects/{p.id}/tables/py_items/realtime", json={"enabled": True}).status_code == 200
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "py", "public": True}).status_code in (200, 201)
    r = p.owner.post(f"/projects/{p.id}/functions", json={"slug": "py-echo", "verify_jwt": False,
        "code": "export default async (req) => ({ status: 200, body: { got: (await req.json()).n } })"})
    assert r.status_code == 201, r.text
    return p


def client(p, key):
    return supabase.create_client(f"{BASE}/p/{p.id}", key)


def test_postgrest_and_rpc(proj):
    db = client(proj, proj.anon_key)
    rows = db.table("py_items").select("id,name").gte("price", 20).order("price", desc=True).execute().data
    assert [r["name"] for r in rows] == ["gamma", "beta"]
    assert db.table("py_items").select("*", count="exact").limit(1).execute().count == 3
    assert db.table("py_items").select("name").eq("id", 1).single().execute().data == {"name": "alpha"}
    admin = client(proj, proj.service_key)
    assert admin.table("py_items").insert({"id": 9, "name": "nine", "price": 9}).execute().data[0]["name"] == "nine"
    assert float(admin.table("py_items").update({"price": 99}).eq("id", 9).execute().data[0]["price"]) == 99
    admin.table("py_items").delete().eq("id", 9).execute()
    assert db.rpc("py_add", {"a": 2, "b": 5}).execute().data == 7


def test_auth_and_rls(proj):
    db = client(proj, proj.anon_key)
    email = f"py-{uuid.uuid4().hex[:8]}@example.com"
    up = db.auth.sign_up({"email": email, "password": "password-123", "options": {"data": {"plan": "free"}}})
    assert up.user.email == email
    s = db.auth.sign_in_with_password({"email": email, "password": "password-123"})
    assert s.session.access_token and db.auth.get_user().user.user_metadata["plan"] == "free"
    note = db.table("py_notes").insert({"body": "mine"}).execute().data[0]
    assert note["owner"] == up.user.id
    assert [n["body"] for n in db.table("py_notes").select("body").execute().data] == ["mine"]
    db.auth.sign_out()
    assert db.table("py_notes").select("body").execute().data == []


def test_storage(proj):
    b = client(proj, proj.service_key).storage.from_("py")
    b.upload("dir/hello.txt", b"hello supabase-py", {"content-type": "text/plain", "upsert": "true"})
    assert b.download("dir/hello.txt") == b"hello supabase-py"
    import requests
    assert requests.get(b.get_public_url("dir/hello.txt"), timeout=10).content == b"hello supabase-py"
    signed = b.create_signed_url("dir/hello.txt", 60)
    assert requests.get(signed["signedURL"] if "signedURL" in signed else signed["signedUrl"], timeout=10).content == b"hello supabase-py"
    assert any(f["name"] == "hello.txt" for f in b.list("dir"))
    b.remove(["dir/hello.txt"])


def test_functions(proj):
    r = client(proj, proj.anon_key).functions.invoke("py-echo", {"body": {"n": 3}})
    import json
    assert json.loads(r) == {"got": 3}


def test_realtime_postgres_changes(proj):
    async def run():
        from supabase import acreate_client
        db = await acreate_client(f"{BASE}/p/{proj.id}", proj.service_key)
        got: asyncio.Queue = asyncio.Queue()
        ch = db.channel("py-items")
        ch.on_postgres_changes("INSERT", schema="public", table="py_items", callback=lambda p: got.put_nowait(p))
        subscribed = asyncio.Event()
        await ch.subscribe(lambda status, err=None: subscribed.set() if str(status).endswith("SUBSCRIBED") else None)
        await asyncio.wait_for(subscribed.wait(), 15)
        await db.table("py_items").insert({"id": 77, "name": "rt-py", "price": 1}).execute()
        payload = await asyncio.wait_for(got.get(), 15)
        await db.remove_all_channels()
        return payload
    # in its own thread: Playwright's sync API may already run an event loop on this one
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(1) as ex:
        payload = ex.submit(lambda: asyncio.run(run())).result(timeout=60)
    data = payload.get("data", payload)
    record = data.get("record") or data.get("new")
    assert record["name"] == "rt-py"
