"""Database webhooks: table changes → signed HTTP calls, filtering, retries, isolation.

The queue worker must reach this machine: set ODB_WEBHOOK_HOST (host.docker.internal
on Docker Desktop) and WEBHOOK_ALLOW_PRIVATE=true on the stack, as for test_phase8.
"""
import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from odb import create_project, wait_until

HOST = os.environ.get("ODB_WEBHOOK_HOST", "127.0.0.1")


@pytest.fixture(scope="module")
def sink():
    got = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def _handle(self):
            raw = self.rfile.read(int(self.headers.get("content-length") or 0))
            got.append({"path": self.path, "method": self.command, "headers": {k.lower(): v for k, v in self.headers.items()}, "raw": raw, "body": json.loads(raw or b"null")})
            status = 500 if self.path.startswith("/fail") else 204
            self.send_response(status); self.end_headers()
        do_POST = do_PUT = do_PATCH = _handle

    srv = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("ODB_DBHOOK_PORT", "9913"))), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield got, srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "DB webhooks")
    p.sql("create table orders (id int primary key, status text, total numeric)")
    return p


def hook(p, name, url, events=("insert", "update", "delete"), **kw):
    r = p.owner.post(f"/projects/{p.id}/webhooks", json={"name": name, "table": "orders", "events": list(events), "url": url, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def received(got, path, n, timeout=20):
    try:
        return wait_until(lambda: (lambda xs: xs if len(xs) >= n else None)([g for g in got if g["path"] == path]), timeout=timeout, interval=0.3)
    except AssertionError:
        if not got:
            pytest.skip("queue worker cannot reach the test machine (set ODB_WEBHOOK_HOST / WEBHOOK_ALLOW_PRIVATE=true)")
        raise


def test_insert_update_delete_signed(proj, sink):
    got, port = sink
    path = f"/all-{uuid.uuid4().hex[:6]}"
    h = hook(proj, "all events", f"http://{HOST}:{port}{path}", secret="whsec-123456", headers={"X-App": "vaartanow"})
    assert h["has_secret"] is True and "secret_encrypted" not in h

    proj.sql("insert into orders values (1, 'new', 10)")
    proj.sql("update orders set status = 'paid' where id = 1")
    proj.sql("delete from orders where id = 1")
    calls = received(got, path, 3)
    by_type = {c["body"]["type"]: c for c in calls}
    assert set(by_type) == {"INSERT", "UPDATE", "DELETE"}
    assert by_type["INSERT"]["body"]["record"] == {"id": 1, "status": "new", "total": 10} and by_type["INSERT"]["body"]["old_record"] is None
    assert by_type["UPDATE"]["body"]["record"]["status"] == "paid" and by_type["UPDATE"]["body"]["old_record"]["status"] == "new"
    assert by_type["DELETE"]["body"]["record"] is None and by_type["DELETE"]["body"]["old_record"]["id"] == 1
    assert by_type["INSERT"]["body"]["table"] == "orders" and by_type["INSERT"]["body"]["schema"] == proj.schema

    c = by_type["INSERT"]
    assert c["headers"]["x-app"] == "vaartanow" and c["headers"]["x-odb-webhook-id"] == h["id"]
    expected = hmac.new(b"whsec-123456", f"{c['headers']['x-odb-timestamp']}.".encode() + c["raw"], hashlib.sha256).hexdigest()
    assert c["headers"]["x-odb-signature"] == f"sha256={expected}"

    deliveries = wait_until(lambda: (lambda d: d if all(x["status"] == "delivered" for x in d) and len(d) == 3 else None)(
        proj.owner.get(f"/projects/{proj.id}/webhooks/{h['id']}/deliveries").json()["data"]), timeout=10)
    assert all(d["last_status_code"] == 204 for d in deliveries)
    assert proj.owner.delete(f"/projects/{proj.id}/webhooks/{h['id']}").status_code == 200


def test_event_filter_and_rollback(proj, sink):
    got, port = sink
    path = f"/deletes-{uuid.uuid4().hex[:6]}"
    h = hook(proj, "deletes only", f"http://{HOST}:{port}{path}", events=["delete"], method="PUT")
    proj.sql("insert into orders values (2, 'new', 5)")
    # the statement fails after the insert: the whole request rolls back, nothing may fire
    proj.sql("insert into orders values (3, 'x', 1); select 1/0", expect_ok=False)
    proj.sql("delete from orders where id = 2")
    calls = received(got, path, 1)
    time.sleep(2)
    calls = [g for g in got if g["path"] == path]
    assert len(calls) == 1 and calls[0]["method"] == "PUT" and calls[0]["body"]["type"] == "DELETE"
    assert proj.sql("select count(*)::int n from orders where id = 3")["data"][0]["n"] == 0
    proj.owner.delete(f"/projects/{proj.id}/webhooks/{h['id']}")


def test_failures_are_retried(proj, sink):
    got, port = sink
    path = f"/fail-{uuid.uuid4().hex[:6]}"
    h = hook(proj, "flaky", f"http://{HOST}:{port}{path}", events=["insert"])
    proj.sql("insert into orders values (4, 'new', 1)")
    received(got, path, 1)
    d = wait_until(lambda: (lambda x: x[0] if x and x[0]["attempts"] >= 1 and x[0]["status"] == "pending" else None)(
        proj.owner.get(f"/projects/{proj.id}/webhooks/{h['id']}/deliveries").json()["data"]), timeout=15)
    assert d["last_status_code"] == 500 and d["last_error"] == "HTTP 500"
    # a pending (not failed) delivery cannot be retried by hand yet
    assert proj.owner.post(f"/projects/{proj.id}/webhooks/{h['id']}/deliveries/{d['id']}/retry").status_code == 404
    listed = next(x for x in proj.owner.get(f"/projects/{proj.id}/webhooks").json()["data"] if x["id"] == h["id"])
    assert listed["pending"] == 1 and listed["trigger_installed"] is True
    proj.owner.delete(f"/projects/{proj.id}/webhooks/{h['id']}")


def test_disable_and_delete_stop_delivery(proj, sink):
    got, port = sink
    path = f"/off-{uuid.uuid4().hex[:6]}"
    h = hook(proj, "toggle", f"http://{HOST}:{port}{path}", events=["insert"])
    assert proj.owner.patch(f"/projects/{proj.id}/webhooks/{h['id']}", json={"enabled": False}).json()["enabled"] is False
    proj.sql("insert into orders values (5, 'new', 1)")
    assert proj.owner.patch(f"/projects/{proj.id}/webhooks/{h['id']}", json={"enabled": True}).status_code == 200
    proj.sql("insert into orders values (6, 'new', 1)")
    calls = received(got, path, 1)
    assert [c["body"]["record"]["id"] for c in calls] == [6]
    assert proj.owner.delete(f"/projects/{proj.id}/webhooks/{h['id']}").status_code == 200
    proj.sql("insert into orders values (7, 'new', 1)")
    time.sleep(3)
    assert [c["body"]["record"]["id"] for c in got if c["path"] == path] == [6]
    trig = proj.sql("select count(*)::int n from pg_trigger where tgname like 'odb_webhook_%' and tgrelid = 'orders'::regclass")["data"][0]["n"]
    assert trig == 0


def test_validation(proj):
    base = {"name": "v", "table": "orders", "events": ["insert"], "url": "https://example.com/hook"}
    assert proj.owner.post(f"/projects/{proj.id}/webhooks", json={**base, "table": "missing"}).status_code == 404
    assert proj.owner.post(f"/projects/{proj.id}/webhooks", json={**base, "url": "ftp://x"}).status_code == 400
    assert proj.owner.post(f"/projects/{proj.id}/webhooks", json={**base, "events": []}).status_code == 400
    assert proj.owner.post(f"/projects/{proj.id}/webhooks", json={**base, "table": "orders; drop table orders"}).status_code == 400


def test_other_projects_cannot_use_the_trigger_function(proj, owner):
    h = hook(proj, "victim", "https://example.com/victim", events=["insert"])
    attacker = create_project(owner, "Webhook attacker")
    attacker.sql("create table t (id int)")
    r = attacker.sql(f"create trigger steal after insert on t for each row execute function control_plane.db_webhook_fire('{h['id']}')", expect_ok=False)
    assert "permission denied" in json.dumps(r).lower() or r.get("error"), r
    proj.owner.delete(f"/projects/{proj.id}/webhooks/{h['id']}")
