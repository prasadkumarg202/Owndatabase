"""OpenTelemetry: requests become traces in Tempo, continuing an incoming traceparent."""
import json
import os
import secrets
import shutil
import subprocess

import pytest
import requests
from odb import URLS, wait_until

TEMPO = os.environ.get("ODB_TEMPO_CONTAINER", "owndatabase-tempo")


def tempo_trace(trace_id: str):
    if not shutil.which("docker"):
        pytest.skip("docker CLI needed to query Tempo inside the stack")
    p = subprocess.run(["docker", "exec", TEMPO, "wget", "-qO-", f"http://127.0.0.1:3200/api/traces/{trace_id}"],
                       capture_output=True, text=True, timeout=20)
    if p.returncode != 0:
        if "No such container" in p.stderr:
            pytest.skip("Tempo is not running")
        return None
    return json.loads(p.stdout)


def spans(trace) -> list[tuple[str, str]]:
    """(service.name, span name) pairs from an OTLP-JSON trace."""
    out = []
    for batch in trace.get("batches") or trace.get("resourceSpans") or []:
        svc = next((a["value"].get("stringValue") for a in batch.get("resource", {}).get("attributes", []) if a["key"] == "service.name"), "?")
        for scope in batch.get("scopeSpans") or batch.get("instrumentationLibrarySpans") or []:
            out += [(svc, s["name"]) for s in scope.get("spans", [])]
    return out


def traceparent():
    trace_id = secrets.token_hex(16)
    return trace_id, f"00-{trace_id}-{secrets.token_hex(8)}-01"


def test_rest_request_is_traced_with_db_span(project):
    project.sql("create table if not exists traced (id int primary key); grant select on traced to anon")
    trace_id, tp = traceparent()
    r = project.rest("GET", "traced", headers={"traceparent": tp})
    assert r.status_code == 200
    if "x-trace-id" not in r.headers:
        pytest.skip("tracing is off (OTEL_EXPORTER_OTLP_ENDPOINT not set on api-service)")
    assert r.headers["x-trace-id"] == trace_id          # the incoming trace is continued
    t = wait_until(lambda: (lambda x: x if x and spans(x) else None)(tempo_trace(trace_id)), timeout=30, interval=1, message="trace in Tempo")
    names = spans(t)
    assert ("api-service", "GET /v1/:projectId/:table") in names, names
    assert ("api-service", "db.transaction") in names, names


def test_function_call_and_other_services_join_the_trace(project):
    project.owner.post(f"/projects/{project.id}/functions", json={"slug": "traced", "code": "export default () => 'ok'", "verify_jwt": False})
    trace_id, tp = traceparent()
    r = requests.get(f"{URLS['functions']}/v1/{project.id}/traced", headers={"apikey": project.anon_key, "traceparent": tp}, timeout=30)
    assert r.status_code == 200, r.text
    # the same trace across services
    project.auth("GET", "settings", headers={"traceparent": tp})
    project.owner.get(f"/projects/{project.id}", headers={"traceparent": tp})
    t = wait_until(lambda: (lambda x: x if x and {"api-service", "control-api"} <= {s for s, _ in spans(x)} else None)(tempo_trace(trace_id)),
                   timeout=30, interval=1, message="spans from several services")
    names = spans(t)
    assert ("api-service", "function.invoke") in names, names
