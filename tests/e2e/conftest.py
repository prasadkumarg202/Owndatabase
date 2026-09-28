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


@pytest.fixture(scope="module")
def ui_user():
    return {"email": f"ui-{uuid.uuid4().hex[:8]}@test.owndatabase.dev", "password": "Ui-" + secrets.token_hex(6)}
