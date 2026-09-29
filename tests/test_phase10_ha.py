"""Phase 10 — the app running on the Patroni HA cluster.

Runs only with ODB_HA=1, against the stack started as in docs/ha.md:
  docker compose -p odb-ha --env-file .env -f infrastructure/ha/docker-compose.ha.yml up -d
  docker compose -f docker-compose.yml -f infrastructure/ha/docker-compose.ha-app.yml up -d --build

Uses the docker CLI to read Patroni state and to crash the primary.
ODB_HA_PROJECT (default odb-ha) is the compose project of the cluster.
"""
import json
import os
import shutil
import subprocess
import time
import uuid

import pytest
from odb import wait_until

pytestmark = pytest.mark.skipif(os.environ.get("ODB_HA") != "1", reason="set ODB_HA=1 to test the Patroni cluster")

HA = os.environ.get("ODB_HA_PROJECT", "odb-ha")
NODES = ["pg1", "pg2", "pg3"]


def docker(*args, check=True, timeout=120) -> str:
    if not shutil.which("docker"):
        pytest.skip("needs the docker CLI")
    p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check:
        assert p.returncode == 0, f"docker {' '.join(args)}\n{p.stdout}\n{p.stderr}"
    return p.stdout


def container(node: str) -> str:
    return f"{HA}-{node}-1"


def members(via: str | None = None) -> list[dict]:
    """patronictl list, asked on the first node that answers."""
    for node in [via] if via else NODES:
        try:  # a crashed or restarting node may hang or refuse; ask the next one
            out = subprocess.run(["docker", "exec", container(node), "patronictl", "list", "-f", "json"],
                                 capture_output=True, text=True, timeout=20)
        except subprocess.TimeoutExpired:
            continue
        if out.returncode == 0:
            return json.loads(out.stdout)
    raise AssertionError("no Patroni node answered")


def leader() -> str:
    return next(m["Member"] for m in members() if m["Role"] == "Leader")


def psql(node: str, sql: str) -> str:
    return docker("exec", container(node), "psql", "-U", "postgres", "-d", "owndatabase", "-XAtc", sql).strip()


def healthy_cluster():
    ms = members()
    roles = sorted(m["Role"] for m in ms)
    ok = (len(ms) == 3 and roles.count("Leader") == 1 and "Sync Standby" in roles
          and all(m["State"] in ("running", "streaming") for m in ms)
          and len({m["TL"] for m in ms}) == 1)
    return ms if ok else None


def test_cluster_has_leader_sync_standby_and_replica():
    ms = wait_until(healthy_cluster, timeout=120, interval=3, message="3 healthy members")
    replicas = [m for m in ms if m["Role"] != "Leader"]
    assert all(m["State"] == "streaming" and m.get("Lag in MB", 0) in (0, None) for m in replicas), ms


def test_app_writes_reach_every_replica(fresh_project):
    marker = uuid.uuid4().hex
    fresh_project.sql(f"create table ha_probe (v text); insert into ha_probe values ('{marker}')")
    schema = fresh_project.schema
    for m in members():
        if m["Role"] != "Leader":
            got = wait_until(lambda: psql(m["Member"], f"select v from {schema}.ha_probe") == marker or None,
                             timeout=30, interval=1, message=f"row on replica {m['Member']}")
            assert got
            assert psql(m["Member"], "select pg_is_in_recovery()") == "t"  # replicas are read-only


def test_replication_is_monitored(platform_admin):
    def scraped():
        r = platform_admin.get("/observability/metrics?query=up%7Bjob%3D%22patroni%22%7D").json()
        ups = {x["metric"]["instance"]: x["value"][1] for x in r["data"]["result"]}
        return ups if len(ups) == 3 and set(ups.values()) == {"1"} else None
    wait_until(scraped, timeout=60, interval=5, message="Prometheus scraping Patroni on all nodes")
    r = platform_admin.get("/observability/metrics?query=sum(patroni_primary)").json()
    assert r["data"]["result"][0]["value"][1] == "1"


def test_wal_g_backups_and_archiving():
    node = leader()
    env = ["exec", "-u", "postgres", container(node), "envdir", "/run/etc/wal-e.d/env"]
    docker(*env, "/scripts/postgres_backup.sh", "/home/postgres/pgdata/pgroot/data", timeout=600)
    backups = json.loads(docker(*env, "wal-g", "backup-list", "--json"))
    assert backups and backups[-1]["backup_name"].startswith("base_"), backups
    archived, failed = psql(node, "select archived_count, failed_count from pg_stat_archiver").split("|")
    assert int(archived) > 0 and int(failed) == 0


@pytest.mark.slow
def test_crash_of_primary_fails_over_without_data_loss(fresh_project):
    p = fresh_project
    p.sql("create table failover_probe (v text)")
    p.sql("insert into failover_probe values ('before-crash')")
    old = leader()
    timeline = next(m["TL"] for m in members() if m["Member"] == old)

    started = time.time()
    docker("kill", container(old))  # SIGKILL: a crash, not a clean shutdown

    def write_ok():
        try:
            p.sql("insert into failover_probe values ('after-failover')")
            return True
        except AssertionError:
            return None
    wait_until(write_ok, timeout=120, interval=2, message="writes through the app after failover")
    outage = time.time() - started

    new = leader()
    assert new != old
    assert next(m["TL"] for m in members(new) if m["Member"] == new) > timeline
    # synchronous_mode: the commit acknowledged before the crash survived
    rows = [r["v"] for r in p.sql("select v from failover_probe order by v")["data"]]
    assert rows == ["after-failover", "before-crash"], rows
    assert outage < 90, f"failover took {outage:.0f}s"

    # the crashed node comes back as a replica of the new primary (pg_rewind if needed)
    docker("start", container(old))
    wait_until(lambda: healthy_cluster() and any(m["Member"] == old and m["Role"] != "Leader" for m in members()),
               timeout=240, interval=5, message=f"{old} to rejoin as a replica")
    print(f"\nfailover: {old} -> {new}, writes resumed after {outage:.1f}s")
