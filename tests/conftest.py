"""
Pytest fixtures for the OwnDatabase test-suite. Helpers live in odb.py.

Point the tests at a running platform with ODB_BASE_URL (gateway, default
http://localhost) or per-service ODB_*_URL variables — see odb.py.
"""
from __future__ import annotations

import os

import pytest
import requests

from odb import URLS, Platform, Project, create_project, signup_platform_user, wait_until  # noqa: F401


@pytest.fixture(scope="session")
def urls():
    return URLS


@pytest.fixture(scope="session", autouse=True)
def _platform_up():
    try:
        r = requests.get(f"{URLS['api']}/api/health", timeout=10)
        assert r.status_code == 200
    except Exception as e:  # pragma: no cover
        pytest.exit(f"Control API not reachable at {URLS['api']} ({e}). Start the platform first.", returncode=2)


@pytest.fixture(scope="session")
def owner() -> Platform:
    return signup_platform_user("owner")


@pytest.fixture(scope="session")
def platform_admin() -> Platform:
    """A platform admin: its email must be in PLATFORM_ADMIN_EMAILS on the control API."""
    email, password = os.environ.get("ODB_ADMIN_EMAIL"), os.environ.get("ODB_ADMIN_PASSWORD")
    if not (email and password):
        pytest.skip("set ODB_ADMIN_EMAIL / ODB_ADMIN_PASSWORD (and PLATFORM_ADMIN_EMAILS on the stack)")
    admin = signup_platform_user("admin", email=email, password=password)
    me = admin.get("/auth/me").json()
    if not me.get("is_platform_admin"):
        pytest.fail(f"{email} is not a platform admin: add it to PLATFORM_ADMIN_EMAILS and restart control-api")
    return admin


@pytest.fixture(scope="session")
def project(owner) -> Project:
    return create_project(owner, "Shared test project")


@pytest.fixture()
def fresh_project(owner) -> Project:
    return create_project(owner)


@pytest.fixture(scope="session")
def dev_mailbox():
    """Reads emails captured by the auth service (AUTH_DEV_MAILBOX=true)."""
    def read(proj: Project, to: str, kind: str | None = None, timeout=10):
        def fetch():
            r = proj.auth("GET", f"_dev/emails?to={to}")
            if r.status_code == 404:
                pytest.skip("AUTH_DEV_MAILBOX is not enabled on the auth service")
            mails = r.json()["data"]
            if kind:
                mails = [m for m in mails if (m.get("meta") or {}).get("type") == kind]
            return mails[0] if mails else None
        return wait_until(fetch, timeout=timeout, interval=0.5, message=f"email to {to}")
    return read
