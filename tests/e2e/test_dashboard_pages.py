"""Dashboard pages for GraphQL, migrations, access tokens, SSO providers and billing administration."""
import os
import re
import secrets
import sys
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from odb import create_project, signup_platform_user  # noqa: E402
import mock_saml_idp  # noqa: E402


def login(page: Page, url: str, email: str, password: str):
    page.goto(f"{url}/login")
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill(password)
    page.get_by_role("button", name="Sign in").click()
    expect(page).to_have_url(re.compile(r"/dashboard$"), timeout=20_000)


@pytest.fixture(scope="module")
def user():
    email, password = f"pages-{secrets.token_hex(4)}@test.owndatabase.dev", "Pages-" + secrets.token_hex(6)
    owner = signup_platform_user("pages", email=email, password=password)
    proj = create_project(owner, "pages")
    proj.sql("create table gql_items (id int primary key, name text); insert into gql_items values (1, 'one');")
    return {"email": email, "password": password, "owner": owner, "project": proj}


def test_access_tokens(page: Page, dashboard_url, user):
    login(page, dashboard_url, user["email"], user["password"])
    page.goto(f"{dashboard_url}/tokens")
    page.get_by_label("Name").fill("ci-deploy")
    page.get_by_test_id("create-token").click()
    expect(page.get_by_text("not shown again")).to_be_visible(timeout=10_000)
    table = page.get_by_test_id("tokens-table")
    expect(table).to_contain_text("ci-deploy")
    table.get_by_role("button", name="Revoke").first.click()
    expect(table).to_contain_text("revoked", timeout=10_000)


def test_migrations(page: Page, dashboard_url, user):
    pid = user["project"].id
    login(page, dashboard_url, user["email"], user["password"])
    page.goto(f"{dashboard_url}/projects/{pid}/migrations")
    page.get_by_label("Name").fill("create_todos")
    page.get_by_test_id("apply-migration").click()
    expect(page.get_by_test_id("migrations-table")).to_contain_text("create_todos", timeout=15_000)
    assert int(user["project"].sql("select count(*) as n from todos")["data"][0]["n"]) == 0


def test_graphql(page: Page, dashboard_url, user):
    pid = user["project"].id
    login(page, dashboard_url, user["email"], user["password"])
    page.goto(f"{dashboard_url}/projects/{pid}/graphql")
    page.get_by_role("button", name="Schema").click()
    expect(page.get_by_test_id("graphql-result")).to_contain_text("__schema", timeout=15_000)


def test_sso_providers(page: Page, dashboard_url, user):
    pid = user["project"].id
    idp = mock_saml_idp.MockIdP()
    login(page, dashboard_url, user["email"], user["password"])
    page.goto(f"{dashboard_url}/projects/{pid}/auth")
    page.get_by_role("tab", name="SSO").click()
    page.get_by_label("IdP metadata URL (https) or metadata XML").fill(idp.metadata())
    page.get_by_label("Email domains (comma-separated)").fill("pages-sso.example.com")
    page.get_by_test_id("add-sso").click()
    table = page.get_by_test_id("sso-providers")
    expect(table).to_contain_text(idp.entity_id, timeout=15_000)
    expect(table).to_contain_text("pages-sso.example.com")
    table.get_by_role("button", name="Remove").click()
    expect(table).not_to_contain_text(idp.entity_id, timeout=10_000)


def test_billing_admin(page: Page, dashboard_url):
    email, password = os.environ.get("ODB_ADMIN_EMAIL"), os.environ.get("ODB_ADMIN_PASSWORD")
    if not email or not password:
        pytest.skip("ODB_ADMIN_EMAIL / ODB_ADMIN_PASSWORD not set")
    login(page, dashboard_url, email, password)
    page.goto(f"{dashboard_url}/admin/billing")
    expect(page.get_by_role("heading", name="Billing administration")).to_be_visible(timeout=15_000)
    expect(page.get_by_text("GST (India)")).to_be_visible()
    toggle = page.get_by_test_id("toggle-billing")
    was_on = "off" in toggle.inner_text()
    toggle.click()
    expect(page.get_by_test_id("toggle-billing")).to_contain_text("Turn billing off" if not was_on else "Turn billing on", timeout=10_000)
    if not was_on:
        expect(page.get_by_test_id("admin-orgs")).to_be_visible(timeout=10_000)
    page.get_by_test_id("toggle-billing").click()   # back as it was
    expect(page.get_by_test_id("toggle-billing")).to_contain_text("Turn billing on" if not was_on else "Turn billing off", timeout=10_000)
