"""Per-project usage limits: set by platform admins, enforced by every service."""
import json
import uuid

import pytest
import requests
import websocket
from odb import URLS, create_project, wait_until


def until_status(call, code, timeout=15):
    """Repeats call() until it returns `code` (limits reach the services via a cache refresh).
    A Response is falsy for 4xx/5xx, so wait_until cannot be given it directly."""
    box = {}
    def check():
        box["r"] = call()
        return box["r"].status_code == code
    try:
        wait_until(check, timeout=timeout, interval=0.5)
    except AssertionError:
        raise AssertionError(f"expected {code}, last: {box['r'].status_code} {box['r'].text[:300]}")
    return box["r"]


@pytest.fixture()
def limited(owner, platform_admin):
    p = create_project(owner, "Limits " + uuid.uuid4().hex[:4])

    def set_limits(**limits):
        r = platform_admin.put(f"/projects/{p.id}/limits", json=limits)
        assert r.status_code == 200, r.text
        return r.json()
    p.set_limits = set_limits
    return p


def test_only_platform_admins_set_limits(limited):
    assert limited.owner.put(f"/projects/{limited.id}/limits", json={"auth_users": 1}).status_code == 403
    r = limited.set_limits(auth_users=5, storage_bytes=1000)
    assert r["limits"]["auth_users"] == 5 and r["limits"]["api_requests_per_day"] is None
    body = limited.owner.get(f"/projects/{limited.id}/limits").json()
    assert body["limits"]["storage_bytes"] == 1000 and body["read_only"] is False
    assert set(body["usage"]) == set(body["limits"])
    # null removes a limit, the others stay
    r = limited.set_limits(auth_users=None)
    assert r["limits"]["auth_users"] is None and r["limits"]["storage_bytes"] == 1000


def test_invalid_limit_values(limited, platform_admin):
    for body in [{"nope": 1}, {"auth_users": -1}, {"auth_users": "10"}]:
        assert platform_admin.put(f"/projects/{limited.id}/limits", json=body).status_code == 400


def test_daily_api_request_quota(limited):
    limited.sql("create table q (id int primary key); grant select on q to anon")
    limited.set_limits(api_requests_per_day=3)
    # services pick up the new limit within moments (project cache invalidation); call until refused
    seen_limit, r = None, None
    for _ in range(30):
        r = limited.rest("GET", "q")
        seen_limit = r.headers.get("X-Quota-Limit") or seen_limit
        if r.status_code == 429:
            break
    assert seen_limit == "3"
    assert r.status_code == 429 and r.json()["error"] == "Quota Exceeded", r.text
    assert 0 < int(r.headers["Retry-After"]) <= 86400
    assert limited.owner.get(f"/projects/{limited.id}/limits").json()["usage"]["api_requests_per_day"] >= 4
    limited.set_limits(api_requests_per_day=None)
    wait_until(lambda: limited.rest("GET", "q").status_code == 200, timeout=10)


def test_function_invocation_quota(limited):
    r = limited.owner.post(f"/projects/{limited.id}/functions", json={"slug": "ping", "code": "export default () => 'pong'", "verify_jwt": False})
    assert r.status_code == 201, r.text
    limited.set_limits(function_invocations_per_day=1)
    url = f"{URLS['functions']}/v1/{limited.id}/ping"
    second = until_status(lambda: requests.get(url, headers={"apikey": limited.anon_key}, timeout=30), 429)
    assert "function invocations" in second.json()["message"]


def test_auth_user_quota(limited):
    limited.set_limits(auth_users=1)
    def signup():
        return limited.auth("POST", "signup", json={"email": f"u-{uuid.uuid4().hex[:8]}@example.com", "password": "password-123"})
    assert signup().status_code == 200
    r = until_status(signup, 402)
    assert r.json()["error"] == "Quota Exceeded"
    r = limited.auth("POST", "admin/users", key=limited.service_key, json={"email": "admin-made@example.com", "password": "password-123"})
    assert r.status_code == 402, r.text


def test_storage_quota(limited):
    s = limited.service_key
    assert limited.storage("POST", "bucket", key=s, json={"name": "files"}).status_code in (200, 201)
    limited.set_limits(storage_bytes=10)
    up = lambda name, data, **h: limited.storage("POST", f"object/files/{name}", key=s, data=data, headers={"content-type": "text/plain", **h})
    wait_until(lambda: up("a.txt", b"12345678").status_code == 200, timeout=10)      # 8 bytes
    r = up("b.txt", b"12345")                                                          # 8 + 5 > 10
    assert r.status_code == 402 and r.json()["error"] == "Quota Exceeded", r.text
    assert up("a.txt", b"123456789", **{"x-upsert": "true"}).status_code == 200       # replaces 8 with 9
    r = limited.storage("POST", "object/copy", key=s, json={"bucketId": "files", "sourceKey": "a.txt", "destinationKey": "c.txt"})
    assert r.status_code == 402


def test_database_size_makes_project_read_only(limited):
    limited.sql("create table big (id int primary key, v text); grant all on big to anon, service_role")
    limited.sql("insert into big select g, repeat('x', 200) from generate_series(1, 200) g")
    assert limited.set_limits(database_bytes=1)["read_only"] is True
    assert limited.owner.get(f"/projects/{limited.id}/limits").json()["read_only"] is True
    k = limited.service_key
    r = until_status(lambda: limited.rest("POST", "big", key=k, json={"id": 1000, "v": "y"}), 402)
    assert "read-only" in r.json()["message"]
    assert limited.rest("PATCH", "big?id=eq.1", key=k, json={"v": "z"}).status_code == 402
    assert limited.rest("GET", "big?id=eq.1", key=k).status_code == 200            # reads work
    assert limited.rest("DELETE", "big?id=eq.2", key=k).status_code in (200, 204)  # and deletes, to get under the limit

    assert limited.set_limits(database_bytes=None)["read_only"] is False
    until_status(lambda: limited.rest("POST", "big", key=k, json={"id": 1001, "v": "y"}), 201)


def test_realtime_connection_quota(limited):
    limited.set_limits(realtime_connections=1)
    url = f"{URLS['realtime']}?project_id={limited.id}&apikey={limited.anon_key}"
    first = websocket.create_connection(url, timeout=10)
    try:
        assert json.loads(first.recv())["type"] == "connected"
        second = websocket.create_connection(url, timeout=10)
        msg = json.loads(second.recv())
        assert msg["type"] == "error" and msg["code"] == "quota_exceeded", msg
        second.close()
    finally:
        first.close()
