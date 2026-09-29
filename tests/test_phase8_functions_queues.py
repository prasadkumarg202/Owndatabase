"""Phase 8 — serverless functions, queues with retries + DLQ, webhooks, cron scheduler."""
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests

from odb import URLS, wait_until

HELLO = """
export default async function (req) {
  console.log('method', req.method, 'role', req.headers['x-odb-role']);
  let fsWriteBlocked = false, spawnBlocked = false;
  try { (await import('node:fs')).writeFileSync('/tmp/odb-fn-test.txt', 'x'); } catch { fsWriteBlocked = true; }
  try { (await import('node:child_process')).execSync('id'); } catch { spawnBlocked = true; }
  const body = typeof req.body === 'object' ? req.body : {};
  return { status: 200, body: { hello: req.query.name ?? body.name ?? 'world', secret: req.env.GREETING_SECRET ?? null,
    user: req.headers['x-odb-user-id'] ?? null, fsWriteBlocked, spawnBlocked, hasDbUrl: !!process.env.DATABASE_URL, path: req.path } };
}
"""


def fn_url(p, slug, extra=""):
    return f"{URLS['functions']}/v1/{p.id}/{slug}{extra}"


@pytest.fixture(scope="module")
def fns(project):
    project.owner.post("/secrets", json={"project_id": project.id, "name": "GREETING_SECRET", "value": "s3cr3t"})
    for slug, code, verify in [
        ("hello", HELLO, False),
        ("private", "export default async (req) => ({ status: 200, body: { user: req.headers['x-odb-user-id'] } })", True),
        ("slow", "export default async () => { await new Promise(r => setTimeout(r, 5000)); return 'late'; }", False),
        ("boom", "export default async () => { throw new Error('kaboom'); }", False),
        ("resp", "export default async () => new Response('<h1>hi</h1>', { status: 201, headers: { 'content-type': 'text/html' } })", False),
    ]:
        r = project.owner.post(f"/projects/{project.id}/functions", json={"slug": slug, "code": code, "verify_jwt": verify, "timeout_ms": 1500 if slug == "slow" else 5000})
        assert r.status_code == 201, r.text
    return project


def test_invoke_function(fns):
    r = requests.post(fn_url(fns, "hello", "/sub/path?name=bob"), headers={"apikey": fns.anon_key}, json={"x": 1}, timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["hello"] == "bob" and body["secret"] == "s3cr3t" and body["path"] == "/sub/path"
    assert body["fsWriteBlocked"] is True and body["spawnBlocked"] is True and body["hasDbUrl"] is False
    assert r.headers["x-odb-function-version"] == "1"


def test_function_requires_key_and_jwt(fns):
    assert requests.get(fn_url(fns, "hello"), timeout=10).status_code == 401
    assert requests.get(fn_url(fns, "private"), headers={"apikey": fns.anon_key}, timeout=10).status_code == 401
    user = fns.new_user()
    r = requests.get(fn_url(fns, "private"), headers={"apikey": fns.anon_key, "Authorization": f"Bearer {user['access_token']}"}, timeout=10)
    assert r.status_code == 200 and r.json()["user"] == user["user"]["id"]
    assert requests.get(fn_url(fns, "missing"), headers={"apikey": fns.anon_key}, timeout=10).status_code == 404


def test_timeout_errors_and_raw_responses(fns):
    r = requests.get(fn_url(fns, "slow"), headers={"apikey": fns.anon_key}, timeout=20)
    assert r.status_code == 504
    r = requests.get(fn_url(fns, "boom"), headers={"apikey": fns.anon_key}, timeout=20)
    assert r.status_code == 500 and "kaboom" in r.json()["message"]
    r = requests.get(fn_url(fns, "resp"), headers={"apikey": fns.anon_key}, timeout=20)
    assert r.status_code == 201 and r.headers["content-type"].startswith("text/html") and r.text == "<h1>hi</h1>"


def test_function_logs_and_versions(fns):
    logs = fns.owner.get(f"/projects/{fns.id}/functions/boom/logs").json()["data"]
    assert logs and logs[0]["status"] == "error" and "kaboom" in logs[0]["error"]
    hello_logs = fns.owner.get(f"/projects/{fns.id}/functions/hello/logs").json()["data"]
    assert "method POST" in hello_logs[0]["logs"]
    r = fns.owner.post(f"/projects/{fns.id}/functions", json={"slug": "hello", "code": "export default () => 'v2'", "verify_jwt": False})
    assert r.json()["version"] == 2
    assert requests.get(fn_url(fns, "hello"), headers={"apikey": fns.anon_key}, timeout=10).json() == "v2"
    listed = {f["slug"]: f for f in fns.owner.get(f"/projects/{fns.id}/functions").json()["data"]}
    assert listed["boom"]["errors_24h"] >= 1
    assert fns.owner.post(f"/projects/{fns.id}/functions", json={"slug": "bad", "code": "console.log(1)"}).status_code == 400


PROBE = """
export default async function (req) {
  const fs = await import('node:fs');
  const tryFetch = async (url) => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return 'reached:' + r.status; }
    catch { return 'blocked'; }
  };
  const tryIt = (f) => { try { f(); return 'allowed'; } catch { return 'blocked'; } };
  const out = { uid: process.getuid(), env: Object.keys(process.env).sort() };
  for (const [k, url] of Object.entries({
    redis: 'http://redis:6379/', postgres: 'http://postgres:5432/', controlApi: 'http://control-api:3000/api/health',
    apiService: 'http://api-service:3003/health', runtimeSelf: 'http://127.0.0.1:3010/health',
    metadata: 'http://169.254.169.254/latest/meta-data/', hostGateway: 'http://172.17.0.1/',
  })) out[k] = await tryFetch(url);
  out.gateway = await tryFetch(req.env.ODB_URL + '/api/health');
  out.listWork = tryIt(() => fs.readdirSync('/work'));
  out.readPasswd = tryIt(() => fs.readFileSync('/etc/passwd'));
  out.readOther = req.query.other ? tryIt(() => fs.readFileSync(req.query.other)) : null;
  out.worker = await (async () => { try { const { Worker } = await import('node:worker_threads'); new Worker('0', { eval: true }); return 'allowed'; } catch { return 'blocked'; } })();
  return out;
}
"""


def runtime_uid(project_id: str) -> int:
    """Mirror of uidFor() in platform/workers/functions-runtime/server.mjs."""
    import hashlib
    return 20000 + int.from_bytes(hashlib.sha256(project_id.encode()).digest()[:4], "big") % 10000


def test_function_isolation(fns, owner):
    from odb import create_project
    other = create_project(owner, "Isolation neighbour")
    r = other.owner.post(f"/projects/{other.id}/functions", json={"slug": "probe", "code": PROBE, "verify_jwt": False, "timeout_ms": 30000})
    assert r.status_code == 201, r.text
    # a real code file of the first project, which the neighbour must not be able to read
    hello = next(f for f in fns.owner.get(f"/projects/{fns.id}/functions").json()["data"] if f["slug"] == "hello")
    target = f"/work/{runtime_uid(fns.id)}/{hello['id']}-v{hello['version']}.mjs"
    requests.get(fn_url(fns, "hello"), headers={"apikey": fns.anon_key}, timeout=20)  # make sure it exists on disk

    r = requests.get(fn_url(other, "probe"), params={"other": target}, headers={"apikey": other.anon_key}, timeout=60)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["uid"] == runtime_uid(other.id) and out["uid"] != runtime_uid(fns.id)
    for k in ["redis", "postgres", "controlApi", "apiService", "runtimeSelf", "metadata", "hostGateway"]:
        assert out[k] == "blocked", (k, out)
    assert out["gateway"] == "reached:200", out
    assert out["listWork"] == out["readPasswd"] == out["readOther"] == out["worker"] == "blocked", out
    assert not any(k in out["env"] for k in ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "FUNCTIONS_RUNTIME_TOKEN"]), out["env"]


def test_function_memory_limit(fns):
    code = "export default async () => { const a = []; for (;;) a.push(new Array(1e6).fill(Math.random())); }"
    r = fns.owner.post(f"/projects/{fns.id}/functions", json={"slug": "hog", "code": code, "verify_jwt": False, "memory_mb": 64, "timeout_ms": 20000})
    assert r.status_code == 201, r.text
    r = requests.get(fn_url(fns, "hog"), headers={"apikey": fns.anon_key}, timeout=60)
    assert r.status_code == 500 and r.json()["error"] == "Function ran out of memory", r.text
    # the runtime survives
    assert requests.get(fn_url(fns, "resp"), headers={"apikey": fns.anon_key}, timeout=20).status_code == 201


@pytest.mark.slow
def test_async_invocation_via_queue(fns):
    r = fns.owner.post(f"/projects/{fns.id}/functions/resp/invoke-async", json={})
    assert r.status_code == 202
    job = r.json()["job_id"]
    j = wait_until(lambda: (lambda x: x if x["state"] in ("completed", "failed") else None)(fns.owner.get(f"/projects/{fns.id}/queues/jobs/{job}").json()), timeout=60)
    assert j["state"] == "completed", j


@pytest.mark.slow
def test_queue_success_failure_dlq_and_retry(project):
    ok = project.owner.post(f"/projects/{project.id}/queues/jobs", json={"type": "noop", "payload": {"a": 1}}).json()
    bad = project.owner.post(f"/projects/{project.id}/queues/jobs", json={"type": "fail.test", "payload": {"message": "nope"}, "attempts": 2}).json()
    j = wait_until(lambda: (lambda x: x if x["state"] == "completed" else None)(project.owner.get(f"/projects/{project.id}/queues/jobs/{ok['id']}").json()), timeout=30)
    assert j["return_value"] == {"ok": True, "echo": {"a": 1}}
    f = wait_until(lambda: (lambda x: x if x["state"] == "failed" else None)(project.owner.get(f"/projects/{project.id}/queues/jobs/{bad['id']}").json()), timeout=60)
    assert f["attempts_made"] == 2 and "nope" in f["failed_reason"]
    dlq = wait_until(lambda: [d for d in project.owner.get(f"/projects/{project.id}/queues/dlq").json()["data"] if str(d["id"]) == str(bad["id"])], timeout=10)
    assert dlq[0]["error"] == "nope"
    overview = project.owner.get(f"/projects/{project.id}/queues").json()["data"]
    assert overview["counts"].get("failed", 0) >= 1 and overview["dead_letter"] >= 1
    assert project.owner.post(f"/projects/{project.id}/queues/jobs/{bad['id']}/retry").status_code == 200


@pytest.fixture()
def webhook_sink():
    got = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"])).decode()
            got.append({"headers": dict(self.headers), "body": json.loads(body)})
            self.send_response(204); self.end_headers()

    port = int(os.environ.get("ODB_WEBHOOK_PORT", "9912"))
    srv = HTTPServer(("0.0.0.0", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield got, port
    srv.shutdown()


@pytest.mark.slow
def test_webhook_dispatch_signed(project, webhook_sink):
    got, port = webhook_sink
    host = os.environ.get("ODB_WEBHOOK_HOST", "127.0.0.1")
    r = project.owner.post(f"/projects/{project.id}/queues/jobs", json={"type": "webhook.dispatch", "payload": {"url": f"http://{host}:{port}/hook", "body": {"event": "order.paid"}, "secret": "whsec"}})
    assert r.status_code == 202
    try:
        wait_until(lambda: got, timeout=20, message="webhook delivery")
    except AssertionError:
        pytest.skip("queue worker cannot reach the test machine (set ODB_WEBHOOK_HOST / WEBHOOK_ALLOW_PRIVATE=true)")
    assert got[0]["body"] == {"event": "order.paid"}
    assert got[0]["headers"]["x-odb-signature"].startswith("sha256=")


def test_cron_jobs_crud_and_run_now(project):
    r = project.owner.post(f"/projects/{project.id}/cron", json={"name": f"tick-{uuid.uuid4().hex[:4]}", "schedule": "*/5 * * * *", "job_type": "noop", "payload": {"c": 1}})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert project.owner.post(f"/projects/{project.id}/cron", json={"name": r.json()["name"], "schedule": "* * * * *", "job_type": "noop"}).status_code == 409
    assert project.owner.post(f"/projects/{project.id}/cron", json={"name": "bad", "schedule": "every day", "job_type": "noop"}).status_code == 400
    # scheduler computes next_run_at
    job = wait_until(lambda: next((c for c in project.owner.get(f"/projects/{project.id}/cron").json()["data"] if c["id"] == cid and c["next_run_at"]), None), timeout=30, message="next_run_at")
    assert job["next_run_at"]
    assert project.owner.post(f"/projects/{project.id}/cron/{cid}/run").status_code == 202
    assert project.owner.patch(f"/projects/{project.id}/cron/{cid}", json={"is_enabled": False}).json()["is_enabled"] is False
    assert project.owner.delete(f"/projects/{project.id}/cron/{cid}").status_code == 200


@pytest.mark.slow
def test_cron_fires_on_schedule(project):
    r = project.owner.post(f"/projects/{project.id}/cron", json={"name": f"every-minute-{uuid.uuid4().hex[:4]}", "schedule": "* * * * *", "job_type": "noop"})
    cid = r.json()["id"]
    fired = wait_until(lambda: next((c for c in project.owner.get(f"/projects/{project.id}/cron").json()["data"] if c["id"] == cid and c["run_count"] >= 1), None), timeout=100, interval=3, message="cron to fire")
    assert fired["last_run_at"]
    project.owner.delete(f"/projects/{project.id}/cron/{cid}")
