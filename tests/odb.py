"""
Shared helpers for the OwnDatabase test-suite (fixtures live in conftest.py).

Two ways to point the tests at a running platform:

  1. Through the gateway (docker compose):   ODB_BASE_URL=http://localhost  (default)
  2. Directly at each service (local dev):   ODB_API_URL, ODB_AUTH_URL, ODB_REST_URL,
     ODB_STORAGE_URL, ODB_REALTIME_URL, ODB_FUNCTIONS_URL, ODB_DASHBOARD_URL

Run:  pip install -r tests/requirements.txt && pytest tests
"""
from __future__ import annotations

import os
import secrets
import time
import uuid
from dataclasses import dataclass, field

import pytest
import requests

BASE = os.environ.get("ODB_BASE_URL", "http://localhost").rstrip("/")


def _url(name: str, default: str) -> str:
    return os.environ.get(name, default).rstrip("/")


URLS = {
    "api": _url("ODB_API_URL", BASE),                         # control API: <api>/api/...
    "auth": _url("ODB_AUTH_URL", f"{BASE}/auth"),              # <auth>/v1/<project>/...
    "rest": _url("ODB_REST_URL", f"{BASE}/rest"),              # <rest>/v1/<project>/<table>
    "storage": _url("ODB_STORAGE_URL", f"{BASE}/storage"),     # <storage>/v1/<project>/...
    "realtime": _url("ODB_REALTIME_URL", BASE.replace("http", "ws", 1) + "/realtime"),
    "functions": _url("ODB_FUNCTIONS_URL", f"{BASE}/functions"),  # <functions>/v1/<project>/<slug>
    "dashboard": _url("ODB_DASHBOARD_URL", BASE),
}


def wait_until(fn, timeout=60, interval=1.0, message="condition"):
    """Poll fn() until it returns a truthy value."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except AssertionError:
            pass
        time.sleep(interval)
    raise AssertionError(f"Timed out waiting for {message}; last value: {last!r}")


@dataclass
class Platform:
    """A signed-in dashboard (platform) user."""
    email: str
    password: str
    token: str = ""
    refresh_token: str = ""
    session: requests.Session = field(default_factory=requests.Session)

    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def req(self, method: str, path: str, **kw) -> requests.Response:
        kw.setdefault("timeout", 60)
        headers = {**self.headers(), **kw.pop("headers", {})}
        return self.session.request(method, f"{URLS['api']}/api{path}", headers=headers, **kw)

    def get(self, path, **kw): return self.req("GET", path, **kw)
    def post(self, path, **kw): return self.req("POST", path, **kw)
    def patch(self, path, **kw): return self.req("PATCH", path, **kw)
    def put(self, path, **kw): return self.req("PUT", path, **kw)
    def delete(self, path, **kw): return self.req("DELETE", path, **kw)


def signup_platform_user(prefix="owner") -> Platform:
    email = f"{prefix}-{uuid.uuid4().hex[:10]}@test.owndatabase.dev"
    password = "Pw-" + secrets.token_hex(8)
    r = requests.post(f"{URLS['api']}/api/auth/signup", json={"email": email, "password": password, "name": prefix}, timeout=30)
    assert r.status_code == 201, r.text
    r = requests.post(f"{URLS['api']}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    return Platform(email=email, password=password, token=body["access_token"], refresh_token=body["refresh_token"])


@dataclass
class Project:
    id: str
    slug: str
    schema: str
    anon_key: str
    service_key: str
    owner: Platform

    def sql(self, query: str, expect_ok=True) -> dict:
        r = self.owner.post(f"/projects/{self.id}/execute", json={"query": query})
        if expect_ok:
            assert r.status_code == 200, r.text
        return r.json()

    # data-plane helpers
    def rest(self, method: str, path: str, key: str | None = None, token: str | None = None, **kw) -> requests.Response:
        headers = {"apikey": key or self.anon_key, **kw.pop("headers", {})}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return requests.request(method, f"{URLS['rest']}/v1/{self.id}/{path.lstrip('/')}", headers=headers, timeout=30, **kw)

    def auth(self, method: str, path: str, key: str | None = None, token: str | None = None, **kw) -> requests.Response:
        headers = {"apikey": key or self.anon_key, **kw.pop("headers", {})}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        kw.setdefault("allow_redirects", False)
        return requests.request(method, f"{URLS['auth']}/v1/{self.id}/{path.lstrip('/')}", headers=headers, timeout=30, **kw)

    def storage(self, method: str, path: str, key: str | None = None, token: str | None = None, **kw) -> requests.Response:
        headers = {**kw.pop("headers", {})}
        if key is not False:
            headers["apikey"] = key or self.anon_key
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return requests.request(method, f"{URLS['storage']}/v1/{self.id}/{path.lstrip('/')}", headers=headers, timeout=60, **kw)

    def new_user(self, password="secret-password-1") -> dict:
        """Sign up an end user and return the session payload."""
        email = f"user-{uuid.uuid4().hex[:10]}@example.com"
        r = self.auth("POST", "signup", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        body = r.json()
        body["email"] = email
        body["password"] = password
        return body


def create_project(owner: Platform, name: str | None = None) -> Project:
    name = name or f"Test {uuid.uuid4().hex[:6]}"
    r = owner.post("/projects", json={"name": name, "slug": "t-" + uuid.uuid4().hex[:10]})
    assert r.status_code == 201, r.text
    b = r.json()
    return Project(id=b["id"], slug=b["slug"], schema=b["db_schema"], anon_key=b["api_keys"]["anon"],
                   service_key=b["api_keys"]["service_role"], owner=owner)


