"""Postgres-native queues (odb_queue): SQL, management API, RPC for apps, isolation."""
import time

import pytest
from odb import create_project, wait_until


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "PG queues")
    r = p.owner.post(f"/projects/{p.id}/pg-queues", json={"name": "emails"})
    assert r.status_code == 201, r.text
    return p


def rpc(p, fn, key=None, token=None, **args):
    return p.rest("POST", f"rpc/{fn}", key=key or p.service_key, token=token, json=args)


def test_send_read_archive_delete_via_rpc(proj):
    ids = [rpc(proj, "queue_send", queue_name="emails", message={"to": f"u{i}@example.com"}).json() for i in range(3)]
    assert all(isinstance(i, int) for i in ids), ids

    got = wait_until(lambda: (lambda r: r if r.status_code == 200 and r.json() else None)(
        rpc(proj, "queue_read", queue_name="emails", sleep_seconds=30, n=2)), timeout=10)
    first = got.json()
    assert [m["msg_id"] for m in first] == ids[:2] and first[0]["message"] == {"to": "u0@example.com"} and first[0]["read_ct"] == 1
    # read messages are invisible for the timeout; the third is next
    nxt = rpc(proj, "queue_read", queue_name="emails", sleep_seconds=30, n=5).json()
    assert [m["msg_id"] for m in nxt] == [ids[2]]
    assert rpc(proj, "queue_read", queue_name="emails", sleep_seconds=30, n=5).json() == []

    assert rpc(proj, "queue_archive", queue_name="emails", message_id=ids[0]).json() is True
    assert rpc(proj, "queue_delete", queue_name="emails", message_id=ids[1]).json() is True
    assert rpc(proj, "queue_delete", queue_name="emails", message_id=ids[1]).json() is False
    archived = proj.owner.get(f"/projects/{proj.id}/pg-queues/emails/messages?archived=true").json()["data"]
    assert [m["msg_id"] for m in archived] == [ids[0]]


def test_visibility_timeout_and_delay(proj):
    proj.owner.post(f"/projects/{proj.id}/pg-queues", json={"name": "vt"})
    m = rpc(proj, "queue_send", queue_name="vt", message={"n": 1}).json()
    assert [x["msg_id"] for x in rpc(proj, "queue_read", queue_name="vt", sleep_seconds=1, n=1).json()] == [m]
    time.sleep(1.5)
    again = rpc(proj, "queue_read", queue_name="vt", sleep_seconds=30, n=1).json()
    assert again[0]["msg_id"] == m and again[0]["read_ct"] == 2          # not acknowledged → redelivered
    delayed = rpc(proj, "queue_send", queue_name="vt", message={"n": 2}, sleep_seconds=60).json()
    assert rpc(proj, "queue_read", queue_name="vt", sleep_seconds=30, n=5).json() == []
    assert rpc(proj, "queue_set_vt", queue_name="vt", message_id=delayed, sleep_seconds=0).json() is True
    assert rpc(proj, "queue_pop", queue_name="vt").json()[0]["msg_id"] == delayed
    metrics = {q["queue_name"]: q for q in proj.owner.get(f"/projects/{proj.id}/pg-queues").json()["data"]}
    assert metrics["vt"]["queue_length"] == 1 and metrics["vt"]["total_messages"] == 2


def test_only_service_role_by_default(proj):
    assert rpc(proj, "queue_send", key=proj.anon_key, queue_name="emails", message={"x": 1}).status_code in (401, 403, 404)
    user = proj.new_user()
    assert rpc(proj, "queue_read", key=proj.anon_key, token=user["access_token"], queue_name="emails", sleep_seconds=1, n=1).status_code in (401, 403, 404)
    # the queue tables are not exposed to the API roles either
    assert proj.rest("GET", "q_emails", key=proj.anon_key).status_code in (401, 403, 404)


def test_sql_and_management_api(proj):
    r = proj.sql("select odb_queue.send('emails', '{\"from\": \"sql\"}') as id")
    msg_id = int(r["data"][0]["id"])   # the SQL editor returns bigint as a string
    peek = proj.owner.get(f"/projects/{proj.id}/pg-queues/emails/messages").json()["data"]
    assert any(m["msg_id"] == msg_id for m in peek)
    assert proj.owner.post(f"/projects/{proj.id}/pg-queues/emails/messages", json={"message": {"a": 1}}).status_code == 201
    assert proj.owner.post(f"/projects/{proj.id}/pg-queues/emails/purge").json()["deleted"] >= 2
    assert proj.owner.post(f"/projects/{proj.id}/pg-queues", json={"name": "Bad-Name"}).status_code == 400
    assert proj.owner.get(f"/projects/{proj.id}/pg-queues/missing/messages").status_code == 404


def test_queues_are_isolated_between_projects(proj, owner):
    other = create_project(owner, "Other queues")
    # the other project's owner role cannot see or use this project's queue
    r = other.sql(f"select * from {proj.schema}.q_emails", expect_ok=False)
    assert "permission denied" in str(r).lower() or "does not exist" in str(r).lower(), r
    r = other.sql("select odb_queue.send('emails', '{}')", expect_ok=False)
    assert "does not exist" in str(r).lower(), r      # resolved in its own schema, where there is no such queue


def test_drop(proj):
    proj.owner.post(f"/projects/{proj.id}/pg-queues", json={"name": "temp"})
    assert proj.owner.delete(f"/projects/{proj.id}/pg-queues/temp").status_code == 200
    assert "temp" not in [q["queue_name"] for q in proj.owner.get(f"/projects/{proj.id}/pg-queues").json()["data"]]


@pytest.mark.slow
def test_backup_of_a_project_with_queues_verifies(proj):
    # queue tables carry a COMMENT and the API wrappers call odb_queue.*: the dump must still verify
    bid = proj.owner.post("/backups", json={"project_id": proj.id}).json()["id"]
    b = wait_until(lambda: (lambda x: x if x["status"] in ("completed", "verified", "failed") else None)(
        proj.owner.get(f"/backups/{bid}").json()), timeout=180, message="backup")
    assert b["status"] == "verified", b["metadata"].get("verify")
