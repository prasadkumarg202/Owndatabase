"""Alerting: Prometheus hands alerts to Alertmanager, which delivers them. The dev .env points
ALERT_WEBHOOK_URL at this test's receiver (http://host.docker.internal:9914/alerts)."""
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

PORT = int(os.environ.get("ODB_ALERT_RECEIVER_PORT", "9914"))


def test_alertmanager_delivers_alerts():
    if not shutil.which("docker"):
        pytest.skip("needs the docker CLI")
    env = subprocess.run(["docker", "exec", "owndatabase-alertmanager", "printenv", "ALERT_WEBHOOK_URL"], capture_output=True, text=True).stdout.strip()
    if f":{PORT}/" not in env:
        pytest.skip(f"ALERT_WEBHOOK_URL does not point at the test receiver (:{PORT})")

    received: list[dict] = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", 0)))
            received.append(json.loads(body))
            self.send_response(200)
            self.end_headers()

    try:
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    except OSError:
        pytest.skip(f"port {PORT} busy")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        name = f"OdbTestAlert{uuid.uuid4().hex[:6]}"
        alert = [{"labels": {"alertname": name, "severity": "warning"},
                  "annotations": {"summary": "delivery test", "description": "sent by tests/test_alerting.py"}}]
        p = subprocess.run(["docker", "exec", "owndatabase-alertmanager", "wget", "-qO-", "--header", "Content-Type: application/json",
                            "--post-data", json.dumps(alert), "http://127.0.0.1:9093/api/v2/alerts"], capture_output=True, text=True, timeout=30)
        assert p.returncode == 0, p.stderr
        deadline = time.time() + 90
        while time.time() < deadline and not any(a["labels"]["alertname"] == name for r in received for a in r.get("alerts", [])):
            time.sleep(1)
        hit = [a for r in received for a in r.get("alerts", []) if a["labels"]["alertname"] == name]
        assert hit, f"alert not delivered; got {len(received)} other notifications"
        assert hit[0]["annotations"]["summary"] == "delivery test" and hit[0]["status"] == "firing"
    finally:
        srv.shutdown()
