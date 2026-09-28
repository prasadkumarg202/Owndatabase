"""Phase 7 — encrypted, verified backups; restore; schedule & retention config."""
import pytest
from odb import create_project, wait_until

pytestmark = pytest.mark.slow


def backup_and_wait(p):
    r = p.owner.post("/backups", json={"project_id": p.id})
    assert r.status_code == 202, r.text
    bid = r.json()["id"]
    b = wait_until(lambda: (lambda x: x if x["status"] in ("completed", "verified", "failed") else None)(p.owner.get(f"/backups/{bid}").json()),
                   timeout=90, message="backup to finish")
    return b


def test_backup_and_restore_roundtrip(owner):
    p = create_project(owner, "Backup test")
    p.sql("create table orders (id int primary key, total numeric); insert into orders values (1, 10), (2, 20)")
    p.owner.post(f"/projects/{p.id}/tables/orders/realtime", json={"enabled": True})
    b = backup_and_wait(p)
    assert b["status"] == "verified", b.get("error_message")
    assert b["is_encrypted"] is True and b["size_bytes"] > 0
    assert b["metadata"]["tables"] == 1 and len(b["metadata"]["checksum_sha256"]) == 64

    # damage the data, then restore
    p.sql("delete from orders; create table junk (x int)")
    r = p.owner.post(f"/backups/{b['id']}/restore", json={"confirm": True})
    assert r.status_code == 202
    rid = r.json()["restore_id"]
    done = wait_until(lambda: next((x for x in p.owner.get(f"/backups/restores?project_id={p.id}").json()["data"] if x["id"] == rid and x["status"] in ("completed", "failed")), None),
                      timeout=90, message="restore to finish")
    assert done["status"] == "completed", done["error_message"]
    assert p.sql("select count(*)::int n from orders")["data"][0]["n"] == 2
    tables = [t["name"] for t in p.owner.get(f"/projects/{p.id}/tables").json()["data"]]
    assert "junk" not in tables
    # REST + realtime trigger still work after restore (ownership and grants re-applied)
    assert len(p.rest("GET", "orders", key=p.service_key).json()) == 2
    assert next(t for t in p.owner.get(f"/projects/{p.id}/tables").json()["data"] if t["name"] == "orders")["realtime_enabled"] is True
    # the project owner can still alter restored tables
    p.sql("alter table orders add column note text")


def test_restore_requires_confirmation(owner, project):
    r = project.owner.post("/backups", json={"project_id": project.id})
    bid = r.json()["id"]
    assert project.owner.post(f"/backups/{bid}/restore", json={}).status_code == 400


def test_backup_config(project):
    cfg = project.owner.get(f"/backups/projects/{project.id}/backup-config").json()
    assert cfg["retention_days"] == 30
    r = project.owner.patch(f"/backups/projects/{project.id}/backup-config", json={"full_cron": "0 3 * * *", "retention_days": 7})
    assert r.status_code == 200 and r.json()["retention_days"] == 7 and r.json()["full_backup_cron"] == "0 3 * * *"
    assert project.owner.patch(f"/backups/projects/{project.id}/backup-config", json={"full_cron": "not a cron"}).status_code == 400


def test_pitr_request_reports_clear_error(owner):
    p = create_project(owner)
    b = backup_and_wait(p)
    r = p.owner.post(f"/backups/{b['id']}/restore", json={"confirm": True, "target_time": "2026-01-01T00:00:00Z"})
    rid = r.json()["restore_id"]
    done = wait_until(lambda: next((x for x in p.owner.get(f"/backups/restores?project_id={p.id}").json()["data"] if x["id"] == rid and x["status"] in ("completed", "failed")), None), timeout=60)
    assert done["status"] == "failed" and "pgBackRest" in done["error_message"]
