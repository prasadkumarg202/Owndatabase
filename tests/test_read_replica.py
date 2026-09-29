"""Read-replica routing for REST reads (x-odb-read-from). Replica assertions need the HA stack (ODB_HA=1)."""
import os

import pytest
import requests
from odb import URLS, wait_until

HA = os.environ.get("ODB_HA") == "1"


@pytest.fixture(scope="module")
def notes(project):
    project.sql("create table if not exists rr_notes (id int primary key, body text); grant select, insert on rr_notes to anon")
    project.sql("insert into rr_notes values (1, 'first') on conflict do nothing")
    return project


def get(p, **headers):
    return p.rest("GET", "rr_notes?select=id,body&order=id", key=p.service_key, headers=headers)


def test_reads_report_where_they_were_served(notes):
    r = get(notes)
    assert r.status_code == 200 and r.json()[0] == {"id": 1, "body": "first"}
    assert r.headers["x-odb-read-from"] in ("primary", "replica")
    strong = get(notes, **{"x-odb-read-consistency": "strong"})
    assert strong.headers["x-odb-read-from"] == "primary"


def test_writes_and_rpc_never_use_the_replica(notes):
    r = notes.rest("POST", "rr_notes", key=notes.service_key, json={"id": 2, "body": "second"}, headers={"Prefer": "return=representation"})
    assert r.status_code in (200, 201), r.text
    assert "x-odb-read-from" not in r.headers


def test_readiness_reports_replica_state():
    ready = requests.get(f"{URLS['rest']}/health/ready", timeout=10)   # the gateway strips /rest
    assert ready.status_code == 200, ready.text
    info = ready.json()["read_replica"]
    assert set(info) == {"configured", "healthy", "lag_bytes"}
    if not HA:
        assert info["configured"] is False


@pytest.mark.skipif(not HA, reason="set ODB_HA=1 (app running on the Patroni cluster)")
def test_ha_reads_go_to_replica_and_catch_up(notes):
    wait_until(lambda: get(notes).headers.get("x-odb-read-from") == "replica", timeout=30, message="replica routing")
    notes.rest("POST", "rr_notes", key=notes.service_key, json={"id": 3, "body": "third"})
    # strong reads see the write immediately; replica reads within a few seconds
    assert 3 in [x["id"] for x in get(notes, **{"x-odb-read-consistency": "strong"}).json()]
    wait_until(lambda: 3 in [x["id"] for x in get(notes).json()], timeout=10, message="replica caught up")
