"""
Playwright end-to-end tests for the dashboard.

Walks through the product like a new user: sign up, create a project, build a
table, write data, run SQL, manage auth users, storage, functions, queues,
cron, backups, logs and settings.

    pytest tests/e2e --browser chromium            (ODB_DASHBOARD_URL=http://localhost)
"""
import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

pytestmark = pytest.mark.e2e
SHOTS = Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)


def alert(page: Page):
    # Next.js renders an empty role=alert route announcer; ignore it
    return page.locator('[role="alert"]:not(#__next-route-announcer__)')


def shot(page: Page, name: str):
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def login(page: Page, url: str, user: dict):
    page.goto(f"{url}/login")
    page.get_by_label("Email").fill(user["email"])
    page.get_by_label("Password").fill(user["password"])
    page.get_by_role("button", name="Sign in").click()
    expect(page).to_have_url(re.compile(r"/dashboard$"), timeout=20_000)


def set_editor(page: Page, text: str):
    ed = page.locator(".cm-content").first
    ed.click()
    page.keyboard.press("Control+A")
    page.keyboard.press("Delete")
    page.keyboard.insert_text(text)


@pytest.fixture(scope="module")
def state():
    return {}


def test_01_protected_routes_redirect_to_login(page: Page, dashboard_url):
    page.goto(f"{dashboard_url}/projects")
    expect(page).to_have_url(re.compile(r"/login\?next="), timeout=15_000)


def test_02_signup(page: Page, dashboard_url, ui_user):
    page.goto(f"{dashboard_url}/login")
    page.get_by_role("button", name="Create an account").click()
    page.get_by_label("Name").fill("UI Tester")
    page.get_by_label("Email").fill(ui_user["email"])
    page.get_by_label("Password").fill("short")
    page.get_by_role("button", name="Create account").click()
    expect(alert(page)).to_contain_text("at least 8")
    page.get_by_label("Password").fill(ui_user["password"])
    page.get_by_role("button", name="Create account").click()
    expect(page).to_have_url(re.compile(r"/dashboard$"), timeout=20_000)
    expect(page.get_by_test_id("service-list")).to_contain_text("postgresql", timeout=15_000)
    shot(page, "01-dashboard")


def test_03_create_project(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{dashboard_url}/projects")
    page.get_by_test_id("new-project").click()
    page.get_by_label("Project name").fill("Playwright App")
    page.get_by_role("button", name="Create project").click()
    created = page.get_by_test_id("project-created")
    expect(created).to_be_visible(timeout=30_000)
    anon = page.get_by_test_id("anon-key").inner_text()
    assert anon.startswith("odb_anon_")
    state["anon"] = anon
    shot(page, "02-project-created")
    page.get_by_role("button", name="Open project").click()
    expect(page).to_have_url(re.compile(r"/projects/[0-9a-f-]{36}$"), timeout=15_000)
    state["project_url"] = page.url
    expect(page.get_by_test_id("rest-url")).to_contain_text("/rest/v1/")
    expect(page.get_by_role("heading", name=re.compile("Playwright App"))).to_be_visible()


def test_04_table_editor(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/database")
    page.get_by_test_id("new-table").click()
    page.get_by_label("Table name").fill("tasks")
    page.get_by_role("button", name="Add column").click()
    rows = page.get_by_test_id("column-row")
    last = rows.nth(2)
    last.get_by_label("Column name").fill("title")
    last.get_by_label("Column type").fill("text")
    page.get_by_role("button", name="Add column").click()
    done = rows.nth(3)
    done.get_by_label("Column name").fill("done")
    done.get_by_label("Column type").fill("boolean")
    done.get_by_label("Default").fill("false")
    page.get_by_role("button", name="Save table").click()
    expect(page.get_by_test_id("tables-list")).to_contain_text("tasks", timeout=15_000)
    page.get_by_role("link", name="tasks").click()
    expect(page).to_have_url(re.compile(r"/table\?name=tasks"))

    # insert a row through the row editor
    page.get_by_test_id("insert-row").click()
    page.locator("#row-title").fill("Write e2e tests")
    page.locator("#row-done").select_option("true")
    page.get_by_test_id("save-row").click()
    expect(page.get_by_test_id("rows-table")).to_contain_text("Write e2e tests", timeout=10_000)
    expect(page.get_by_test_id("rows-table")).to_contain_text("true")
    shot(page, "03-table-data")

    # structure: add a column
    page.get_by_role("tab", name="Structure").click()
    page.get_by_label("New column").fill("priority")
    page.get_by_label("Type", exact=True).fill("integer")
    page.get_by_test_id("add-column").click()
    expect(page.get_by_test_id("columns-table")).to_contain_text("priority", timeout=10_000)

    # policies: RLS was enabled on create → add a read policy from a template
    page.get_by_role("tab", name=re.compile("Policies")).click()
    page.get_by_label("Template").select_option("Everyone can read")
    page.get_by_test_id("create-policy").click()
    expect(page.get_by_test_id("policies-table")).to_contain_text("everyone_can_read", timeout=10_000)
    shot(page, "04-policies")


def test_05_rest_api_reads_what_the_ui_wrote(page: Page, state):
    pid = state["project_url"].rstrip("/").split("/")[-1]
    base = state["project_url"].split("/projects/")[0]
    r = page.request.get(f"{base}/rest/v1/{pid}/tasks?select=title,done", headers={"apikey": state["anon"]})
    assert r.status == 200, r.text()
    assert r.json() == [{"title": "Write e2e tests", "done": True}]


def test_06_sql_editor(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/sql")
    set_editor(page, "select title, done from tasks order by title;")
    page.get_by_test_id("run-sql").click()
    expect(page.get_by_test_id("sql-result")).to_contain_text("Write e2e tests", timeout=15_000)
    set_editor(page, "select * from missing_table;")
    page.get_by_test_id("run-sql").click()
    expect(alert(page)).to_contain_text("does not exist", timeout=10_000)
    page.get_by_role("button", name="Explain analyze").click()
    shot(page, "05-sql-editor")


def test_07_auth_users(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/auth")
    page.get_by_test_id("add-user").click()
    page.get_by_label("Email").fill("person@example.com")
    page.get_by_label("Password").fill("person-password-1")
    page.get_by_test_id("create-user").click()
    table = page.get_by_test_id("users-table")
    expect(table).to_contain_text("person@example.com", timeout=10_000)
    table.get_by_text("person@example.com").click()
    expect(page.get_by_test_id("user-detail")).to_be_visible()
    page.get_by_test_id("ban-user").click()
    expect(page.get_by_test_id("user-detail")).to_contain_text("banned until", timeout=10_000)
    page.keyboard.press("Escape")
    page.get_by_role("tab", name="Settings").click()
    page.get_by_label("Minimum password length").fill("10")
    page.get_by_label("Enable phone sign-in").check()
    page.get_by_label("SMS provider").select_option("webhook")
    page.get_by_label("Webhook URL").fill("https://sms.example.com/send")
    page.get_by_label("Signing secret (x-odb-signature)").fill("hook-secret")
    page.get_by_test_id("save-auth-settings").click()
    expect(page.get_by_role("status").filter(has_text="Auth settings saved")).to_be_visible(timeout=10_000)
    # the secret comes back masked
    expect(page.get_by_label("Signing secret (x-odb-signature)")).to_have_value("••••••••")
    shot(page, "06-auth")


def test_08_storage(page: Page, dashboard_url, ui_user, state, tmp_path):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/storage")
    page.get_by_test_id("new-bucket").click()
    page.get_by_label("Name").fill("uploads")
    page.get_by_label(re.compile("Public bucket")).check()
    page.get_by_test_id("create-bucket").click()
    expect(page.get_by_test_id("bucket-list")).to_contain_text("uploads", timeout=10_000)
    f = tmp_path / "report.txt"
    f.write_text("quarterly numbers")
    page.get_by_test_id("file-input").set_input_files(str(f))
    expect(page.get_by_test_id("object-list")).to_contain_text("report.txt", timeout=15_000)
    page.get_by_role("button", name="Get link").first.click()
    link = page.get_by_test_id("file-link").inner_text()
    assert "/object/public/uploads/report.txt" in link
    assert page.request.get(link).text() == "quarterly numbers"
    shot(page, "07-storage")


def test_09_functions(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/functions")
    page.get_by_test_id("new-function").click()
    page.get_by_label("Slug").fill("greet")
    page.get_by_test_id("deploy-function").click()
    expect(page.get_by_test_id("function-list")).to_contain_text("greet", timeout=15_000)
    pid = state["project_url"].rstrip("/").split("/")[-1]
    base = state["project_url"].split("/projects/")[0]
    r = page.request.get(f"{base}/functions/v1/{pid}/greet?name=Playwright", headers={"apikey": state["anon"]})
    assert r.status == 200 and r.json() == {"message": "Hello Playwright!"}
    expect(page.get_by_test_id("function-logs")).to_contain_text("HTTP 200", timeout=15_000)
    shot(page, "08-functions")


def test_10_queues_and_cron(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/queues")
    page.get_by_test_id("enqueue-job").click()
    expect(page.get_by_test_id("jobs-table")).to_contain_text("noop", timeout=15_000)
    expect(page.get_by_test_id("jobs-table")).to_contain_text("completed", timeout=20_000)
    page.goto(f"{state['project_url']}/cron")
    page.get_by_test_id("new-cron").click()
    page.get_by_label("Name").fill("hourly-noop")
    page.get_by_label("Job type").select_option("noop")
    page.get_by_label("Payload (JSON)").fill("{}")
    page.get_by_test_id("create-cron").click()
    expect(page.get_by_test_id("cron-table")).to_contain_text("hourly-noop", timeout=10_000)
    shot(page, "09-cron")


def test_11_backups(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/backups")
    page.get_by_test_id("create-backup").click()
    expect(page.get_by_test_id("backups-table")).to_contain_text("verified", timeout=60_000)
    shot(page, "10-backups")


def test_12_logs_reports_settings(page: Page, dashboard_url, ui_user, state):
    login(page, dashboard_url, ui_user)
    page.goto(f"{state['project_url']}/logs")
    expect(page.get_by_test_id("logs-table")).to_contain_text("project.created", timeout=15_000)
    page.get_by_test_id("range-custom").click()
    expect(page.get_by_label("From date")).to_be_visible()
    page.get_by_test_id("range-1h").click()
    shot(page, "11-logs")

    page.goto(f"{state['project_url']}/reports")
    expect(page.get_by_test_id("report-stats")).to_contain_text("Cache hit ratio", timeout=15_000)

    page.goto(f"{state['project_url']}/settings")
    page.get_by_role("tab", name="API keys").click()
    page.get_by_test_id("new-key").click()
    page.get_by_label("Name").fill("Mobile app")
    page.get_by_test_id("create-key").click()
    expect(page.get_by_test_id("new-key-value")).to_contain_text("odb_anon_", timeout=10_000)
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("keys-table")).to_contain_text("Mobile app")
    page.get_by_role("tab", name="Secrets").click()
    page.get_by_label("Name").fill("PAYMENT_KEY")
    page.get_by_label("Value").fill("sk_test_123")
    page.get_by_test_id("save-secret").click()
    expect(page.get_by_test_id("secrets-table")).to_contain_text("PAYMENT_KEY", timeout=10_000)
    shot(page, "12-settings")


def test_13_sign_out(page: Page, dashboard_url, ui_user):
    login(page, dashboard_url, ui_user)
    page.get_by_test_id("user-menu").click()
    page.get_by_role("button", name="Sign out").click()
    expect(page).to_have_url(re.compile(r"/login"), timeout=10_000)
    page.goto(f"{dashboard_url}/dashboard")
    expect(page).to_have_url(re.compile(r"/login"), timeout=10_000)
