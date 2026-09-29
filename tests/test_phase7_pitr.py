"""Phase 7 — cluster backups with pgBackRest, WAL archiving, point-in-time restore.

The PITR round-trip rolls the WHOLE cluster back a few seconds, so it only runs
with ODB_DESTRUCTIVE_TESTS=1. It drives scripts/pitr-restore.sh, which needs
bash and the docker CLI on the test machine.

With ODB_HA=1 (app running on the Patroni cluster) backups are made by WAL-G
instead; those are covered in test_phase10_ha.py.
"""
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
import requests
from odb import URLS, wait_until

ROOT = Path(__file__).resolve().parent.parent
single_node_only = pytest.mark.skipif(os.environ.get("ODB_HA") == "1",
                                      reason="pgBackRest is single-node; HA backups are tested in test_phase10_ha.py")


def cluster_backups(admin) -> dict:
    r = admin.get("/cluster/backups")
    assert r.status_code == 200, r.text
    return r.json()


def test_cluster_backups_are_platform_admin_only(owner):
    assert owner.get("/cluster/backups").status_code == 403


@single_node_only
def test_cluster_backup_status(platform_admin):
    b = wait_until(lambda: (lambda x: x if x["backups"] else None)(cluster_backups(platform_admin)),
                   timeout=120, interval=5, message="first pgBackRest backup")
    assert b["configured"] and b["status"] == "ok", b
    assert b["last_error"] is None, b["last_error"]
    assert b["backups"][0]["type"] == "full"
    assert all(x["finished_at"] and x["database_bytes"] > 0 for x in b["backups"])
    assert b["wal_archive"]["archived_count"] > 0
    assert b["pitr_window"]["from"] and b["pitr_window"]["to"]


def test_wal_is_archived_continuously(platform_admin, fresh_project):
    # archive_timeout = 60s: after a write, a newer WAL segment must reach the repository
    before = cluster_backups(platform_admin)["wal_archive"]["last_archived_wal"]
    fresh_project.sql("create table wal_probe (x int); insert into wal_probe select generate_series(1, 1000)")
    wait_until(lambda: cluster_backups(platform_admin)["wal_archive"]["last_archived_wal"] != before,
               timeout=150, interval=5, message="a new WAL segment to be archived")
    assert cluster_backups(platform_admin)["wal_archive"]["failed_count"] == 0


@single_node_only
@pytest.mark.skipif(os.environ.get("ODB_DESTRUCTIVE_TESTS") != "1",
                    reason="rolls the whole cluster back: set ODB_DESTRUCTIVE_TESTS=1")
def test_point_in_time_restore(fresh_project):
    bash = os.environ.get("ODB_BASH") or shutil.which("bash")
    if not bash or not shutil.which("docker"):
        pytest.skip("needs bash and the docker CLI")
    p = fresh_project
    p.sql("create table pitr_probe (v text); insert into pitr_probe values ('before')")
    target = p.sql("select to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as t")["data"][0]["t"]
    time.sleep(2)
    p.sql("insert into pitr_probe values ('after'); drop table if exists nothing_here")

    run = subprocess.run([bash, "scripts/pitr-restore.sh", "--yes", target], cwd=ROOT,
                         capture_output=True, text=True, timeout=900)
    assert run.returncode == 0, f"stdout:\n{run.stdout}\nstderr:\n{run.stderr}"

    wait_until(lambda: requests.get(f"{URLS['api']}/api/health", timeout=5).status_code == 200,
               timeout=180, interval=3, message="control API after restore")
    rows = wait_until(lambda: p.sql("select v from pitr_probe order by v")["data"],
                      timeout=60, interval=3, message="project data after restore")
    assert [r["v"] for r in rows] == ["before"]
