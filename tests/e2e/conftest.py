import os
import secrets
import uuid

import pytest

DASH = os.environ.get("ODB_DASHBOARD_URL", os.environ.get("ODB_BASE_URL", "http://localhost")).rstrip("/")


@pytest.fixture(scope="session")
def dashboard_url():
    return DASH


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    return {**browser_context_args, "viewport": {"width": 1440, "height": 900}}


ROUTES = ["/login", "/dashboard", "/projects", "/organizations", "/status", "/invite/warmup", "/tokens", "/admin/billing"] + [
    f"/projects/00000000-0000-0000-0000-000000000000{p}" for p in
    ["", "/database", "/table", "/sql", "/auth", "/storage", "/realtime", "/functions", "/queues", "/cron",
     "/webhooks", "/branches", "/backups", "/logs", "/reports", "/settings", "/graphql", "/migrations"]]


@pytest.fixture(scope="session", autouse=True)
def _warm_dashboard():
    """The dashboard runs `next dev`, which compiles each route on its first request — after a
    rebuild that can take longer than a UI assertion waits. Compile every route up front."""
    import requests
    from playwright.sync_api import expect
    for route in ROUTES:
        try:
            requests.get(f"{DASH}{route}", timeout=180)
        except requests.RequestException:
            pass
    expect.set_options(timeout=15_000)


@pytest.fixture(scope="module")
def ui_user():
    return {"email": f"ui-{uuid.uuid4().hex[:8]}@test.owndatabase.dev", "password": "Ui-" + secrets.token_hex(6)}
