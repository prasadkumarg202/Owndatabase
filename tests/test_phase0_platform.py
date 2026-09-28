"""Phase 0 — every service is up and exposes health + metrics."""
import requests
from odb import URLS


def test_control_api_health():
    r = requests.get(f"{URLS['api']}/api/health", timeout=10)
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_control_api_ready_checks_dependencies():
    r = requests.get(f"{URLS['api']}/api/health/ready", timeout=10)
    assert r.status_code == 200
    assert r.json()["checks"]["postgresql"]["status"] == "healthy"
    assert r.json()["checks"]["redis"]["status"] == "healthy"


def test_openapi_docs_available():
    r = requests.get(f"{URLS['api']}/api/docs/json", timeout=10)
    assert r.status_code == 200
    spec = r.json()
    assert spec["openapi"].startswith("3.")
    assert any(p.startswith("/api/projects") for p in spec["paths"])


def test_all_services_healthy(owner):
    r = owner.get("/observability/services")
    assert r.status_code == 200
    services = {s["name"]: s["status"] for s in r.json()["data"]}
    for name in ["control-api", "postgresql", "redis", "auth", "rest", "realtime", "storage", "queue-worker", "cron-scheduler", "backup-worker"]:
        assert services.get(name) == "healthy", f"{name}: {services.get(name)}"


def test_unknown_route_is_json_404():
    r = requests.get(f"{URLS['api']}/api/does-not-exist", timeout=10)
    assert r.status_code == 404
    assert r.json()["error"] == "Not Found"
