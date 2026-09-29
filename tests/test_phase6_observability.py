"""Phase 6 — metrics endpoints, logs, usage, alerts, audit trail.

/metrics endpoints are only reachable inside the Docker network, so metrics are
checked through Prometheus (via the control API's PromQL endpoint), which is
what actually scrapes them.
"""
import os
from urllib.parse import quote, urlparse

import pytest
import requests
from odb import BASE, URLS, wait_until


def promql(user, query: str) -> list:
    r = user.get(f"/observability/metrics?query={quote(query)}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "success", body
    return body["data"]["result"]


def test_metrics_not_public_through_gateway():
    r = requests.get(f"{URLS['api']}/metrics", timeout=10)
    assert r.status_code == 404 and "http_requests_total" not in r.text
    # each service's /metrics (project ids, request counts) must not be reachable via its public prefix
    for base in (URLS["rest"], URLS["auth"], URLS["storage"], f"{URLS['api']}/api", f"{URLS['api']}/functions"):
        r = requests.get(f"{base}/metrics", timeout=10)
        assert r.status_code == 404 and "# HELP" not in r.text, base


def test_raw_metrics_are_platform_admin_only(owner):
    # every signup owns an organization, so org ownership must not unlock cluster-wide PromQL
    r = owner.get("/observability/metrics?query=up")
    assert r.status_code == 403, r.text
    assert owner.get("/auth/me").json()["is_platform_admin"] is False


def test_control_api_metrics(platform_admin):
    series = promql(platform_admin, 'http_requests_total{job="control-api"}')
    assert series, "Prometheus has no http_requests_total series for control-api"


def test_project_logs_include_audit_and_auth(fresh_project):
    # A fresh project, so project.created is still within the newest 200 entries.
    fresh_project.new_user()
    logs = fresh_project.owner.get(f"/projects/{fresh_project.id}/logs?limit=200").json()["data"]
    sources = {l["source"] for l in logs}
    assert {"audit", "auth"} <= sources
    assert any(l["event"] == "project.created" for l in logs)
    only_auth = fresh_project.owner.get(f"/projects/{fresh_project.id}/logs?source=auth").json()["data"]
    assert only_auth and all(l["source"] == "auth" for l in only_auth)


def test_audit_log_is_append_only(project):
    r = project.owner.post(f"/projects/{project.id}/execute", json={"query": "delete from control_plane.audit_logs"})
    assert r.status_code == 400  # not even reachable from the project role
    audit = project.owner.get(f"/projects/{project.id}/audit-logs").json()["data"]
    assert audit and audit[0]["event_type"]


def test_usage(project):
    project.new_user()
    project.rest("GET", "late_table")
    u = project.owner.get(f"/projects/{project.id}/usage").json()["data"]
    assert u["auth_users"] >= 1
    assert u["today"].get("rest_requests", 0) >= 1


def test_alerts_endpoint(owner):
    r = owner.get("/observability/alerts")
    assert r.status_code == 200
    body = r.json()
    assert "data" in body and "configured" in body
    if body["configured"] and not body.get("error"):
        assert body["rule_count"] >= 10


def test_service_metrics_exposed(owner, platform_admin):
    # every data-plane service exposes /metrics next to /health, and Prometheus
    # scrapes it successfully (up == 1 for the same host:port)
    services = [s for s in owner.get("/observability/services").json()["data"] if s["url"].startswith("http")]
    assert services
    expected = {urlparse(s["url"]).netloc: s["name"] for s in services}

    down = {}

    def all_up():
        up = {r["metric"]["instance"]: r["value"][1] for r in promql(platform_admin, "up")}
        down.clear()
        down.update({name: up.get(inst, "not scraped") for inst, name in expected.items() if up.get(inst) != "1"})
        return not down

    try:  # a just-restarted service may miss one scrape (15s interval)
        wait_until(all_up, timeout=30, interval=3)
    except AssertionError:
        pass
    assert not down, f"services without working /metrics (Prometheus up != 1): {down}"


def test_host_metrics_scraped(platform_admin):
    # node-exporter (host CPU / memory / disk for the alert rules) is up
    series = promql(platform_admin, 'up{job="node"}')
    assert series and series[0]["value"][1] == "1", series


def test_grafana_up_with_provisioned_datasources():
    r = requests.get(f"{BASE}/grafana/api/health", timeout=10)
    assert r.status_code == 200 and r.json()["database"] == "ok"
    password = os.environ.get("GRAFANA_PASSWORD")
    if not password:
        pytest.skip("set GRAFANA_PASSWORD to check the provisioned datasources")
    auth = (os.environ.get("GRAFANA_USER", "admin"), password)
    for uid, kind in (("prometheus", "prometheus"), ("loki", "loki")):  # uids the dashboards use
        d = requests.get(f"{BASE}/grafana/api/datasources/uid/{uid}", auth=auth, timeout=10)
        assert d.status_code == 200 and d.json()["type"] == kind, (uid, d.text)
