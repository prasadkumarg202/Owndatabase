"""Log drains: a project's auth / audit / function / platform logs forwarded to a webhook, Datadog or
Better Stack. A local receiver stands in for all three (the URLs point at it; the dev stack allows private
targets with WEBHOOK_ALLOW_PRIVATE=true)."""
import hashlib
import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from odb import create_project, signup_platform_user, wait_until

PORT = int(os.environ.get("ODB_DRAIN_RECEIVER_PORT", "9915"))
HOST = os.environ.get("ODB_WEBHOOK_HOST", "host.docker.internal")


class Receiver:
    def __init__(self):
        self.hits: list[dict] = []
        self.fail_paths: set[str] = set()
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                outer.hits.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "raw": body, "json": json.loads(body)})
                self.send_response(500 if self.path in outer.fail_paths else 202)
                self.end_headers()

        self.srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def url(self, path):
        return f"http://{HOST}:{PORT}{path}"

    def on(self, path):
        return [h for h in self.hits if h["path"] == path]


@pytest.fixture(scope="module")
def rx():
    try:
        r = Receiver()
    except OSError:
        pytest.skip(f"port {PORT} busy")
    yield r
    r.srv.shutdown()


@pytest.fixture(scope="module")
def proj(owner):
    return create_project(owner, "drains")


def drains(p):
    return f"/projects/{p.id}/log-drains"


def events_on(rx, path):
    out = []
    for h in rx.on(path):
        j = h["json"]
        out.extend(j["events"] if isinstance(j, dict) else j)
    return out


def test_validation_and_secrets_never_returned(proj):
    o = proj.owner
    assert o.post(drains(proj), json={"kind": "webhook"}).status_code == 400
    assert o.post(drains(proj), json={"kind": "datadog"}).status_code == 400
    assert o.post(drains(proj), json={"kind": "logtail", "secret": "x", "url": "ftp://x"}).status_code == 400
    assert o.post(drains(proj), json={"kind": "datadog", "secret": "k", "site": "evil.example.com"}).status_code == 400
    stranger = signup_platform_user("drain-stranger")
    assert stranger.get(drains(proj)).status_code in (403, 404)


def test_webhook_drain_delivers_signed_logs(proj, rx):
    o = proj.owner
    r = o.post(drains(proj), json={"name": "hook", "kind": "webhook", "url": rx.url("/hook"), "secret": "drain-secret"})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["has_secret"] is True and "secret" not in d and d["enabled"] is True
    # test button
    t = o.post(f"{drains(proj)}/{d['id']}/test").json()
    assert t == {"ok": True}, t
    assert any(e["event"] == "log_drain.test" for e in events_on(rx, "/hook"))
    # real activity: an end-user sign-up (auth) and a dashboard change (audit)
    proj.new_user()
    o.post("/keys", json={"project_id": proj.id, "name": "drain-audit", "type": "anon"})
    wait_until(lambda: {"auth", "audit"} <= {e["source"] for e in events_on(rx, "/hook")}, timeout=60, message="auth + audit events")
    ev = [e for e in events_on(rx, "/hook") if e["source"] == "auth"][0]
    assert ev["project_id"] == proj.id and ev["event"] and ev["timestamp"]
    # every delivery is signed: HMAC-SHA256(secret, "<timestamp>.<body>")
    for h in rx.on("/hook"):
        mac = hmac.new(b"drain-secret", f"{h['headers']['x-odb-timestamp']}.".encode() + h["raw"], hashlib.sha256).hexdigest()
        assert h["headers"]["x-odb-signature"] == f"sha256={mac}"
    # status shows the delivery
    listed = [x for x in o.get(drains(proj)).json()["data"] if x["id"] == d["id"]][0]
    assert listed["last_delivered_at"] and listed["consecutive_failures"] == 0


def test_datadog_and_better_stack_formats(proj, rx):
    o = proj.owner
    dd = o.post(drains(proj), json={"kind": "datadog", "secret": "dd-key", "url": rx.url("/dd"), "sources": ["auth"]}).json()
    lt = o.post(drains(proj), json={"kind": "logtail", "secret": "lt-token", "url": rx.url("/lt"), "sources": ["auth"]}).json()
    assert o.post(f"{drains(proj)}/{dd['id']}/test").json()["ok"] and o.post(f"{drains(proj)}/{lt['id']}/test").json()["ok"]
    proj.new_user()
    wait_until(lambda: any(e.get("ddsource") == "owndatabase" and "auth" in e["service"] for e in events_on(rx, "/dd"))
               and any(e.get("source") == "auth" for e in events_on(rx, "/lt")), timeout=60, message="datadog + logtail deliveries")
    assert all(h["headers"]["dd-api-key"] == "dd-key" for h in rx.on("/dd"))
    assert all(h["headers"]["authorization"] == "Bearer lt-token" for h in rx.on("/lt"))
    e = [x for x in events_on(rx, "/dd") if "auth" in x["service"]][0]
    assert f"project_id:{proj.id}" in e["ddtags"] and e["message"] and e["date"]
    # only the chosen sources
    assert all(x["source"] == "auth" for x in events_on(rx, "/lt") if x.get("event") != "log_drain.test")


def test_failures_are_recorded_and_reenabling_resets(proj, rx):
    o = proj.owner
    rx.fail_paths.add("/down")
    d = o.post(drains(proj), json={"kind": "webhook", "url": rx.url("/down"), "sources": ["auth"]}).json()
    assert o.post(f"{drains(proj)}/{d['id']}/test").json()["ok"] is False
    proj.new_user()
    wait_until(lambda: [x for x in o.get(drains(proj)).json()["data"] if x["id"] == d["id"]][0]["consecutive_failures"] >= 1,
               timeout=60, message="a failed delivery")
    row = [x for x in o.get(drains(proj)).json()["data"] if x["id"] == d["id"]][0]
    assert "500" in row["last_error"]
    # fixed endpoint + re-enable: delivered, failures cleared
    rx.fail_paths.discard("/down")
    assert o.patch(f"{drains(proj)}/{d['id']}", json={"enabled": False}).json()["enabled"] is False
    r = o.patch(f"{drains(proj)}/{d['id']}", json={"enabled": True}).json()
    assert r["enabled"] is True and r["consecutive_failures"] == 0 and r["last_error"] is None
    wait_until(lambda: [x for x in o.get(drains(proj)).json()["data"] if x["id"] == d["id"]][0]["last_delivered_at"], timeout=60, message="delivery after fix")
    assert o.delete(f"{drains(proj)}/{d['id']}").status_code == 200


def test_limit(proj):
    o = proj.owner
    n = len(o.get(drains(proj)).json()["data"])
    for _ in range(5 - n):
        assert o.post(drains(proj), json={"kind": "webhook", "url": "https://example.com/logs"}).status_code == 201
    assert o.post(drains(proj), json={"kind": "webhook", "url": "https://example.com/logs"}).status_code == 409
