"""Custom domains: verification, Caddy's on-demand TLS check, host-based routing of every API."""
import json
import secrets
import time

import pytest
import requests
import websocket
from odb import BASE, URLS, create_project, wait_until


@pytest.fixture()
def dom(owner, platform_admin):
    p = create_project(owner, "Custom domain")
    p.sql("create table things (id int primary key, name text); insert into things values (1, 'one'); grant select on things to anon")
    host = f"api-{secrets.token_hex(4)}.example.com"
    r = p.owner.post(f"/projects/{p.id}/domains", json={"hostname": host.upper()})
    assert r.status_code == 201, r.text
    d = r.json()
    p.domain, p.domain_id, p.admin = host, d["id"], platform_admin
    return p


def via(p, path, host=None, **kw):
    """A request to the gateway as if sent to https://<custom domain><path>."""
    headers = {"Host": host or p.domain, **kw.pop("headers", {})}
    return requests.request(kw.pop("method", "GET"), f"{BASE}{path}", headers=headers, timeout=15, **kw)


def test_add_verify_and_route(dom):
    d = dom.owner.get(f"/projects/{dom.id}/domains").json()["data"][0]
    assert d["hostname"] == dom.domain and d["status"] == "pending"
    txt = next(r for r in d["dns_records"] if r["type"] == "TXT")
    assert txt["name"] == f"_odb-challenge.{dom.domain}" and txt["value"].startswith("odb-verify-")
    assert d["endpoints"]["rest_url"] == f"https://{dom.domain}/rest/v1"

    # no DNS record for example.com subdomains: stays pending, with a reason
    r = dom.owner.post(f"/projects/{dom.id}/domains/{dom.domain_id}/verify").json()
    assert r["status"] == "pending" and r["last_error"]
    # not verified → not routed, and Caddy would refuse a certificate
    assert requests.get(f"{URLS['api']}/api/internal/domains/check", params={"domain": dom.domain}, timeout=10).status_code == 404
    assert via(dom, "/rest/v1/things", headers={"apikey": dom.anon_key}).status_code == 404

    assert dom.owner.post(f"/projects/{dom.id}/domains/{dom.domain_id}/force-verify").status_code == 403   # admins only
    assert dom.admin.post(f"/projects/{dom.id}/domains/{dom.domain_id}/force-verify").json()["status"] == "verified"
    assert requests.get(f"{URLS['api']}/api/internal/domains/check", params={"domain": dom.domain.upper()}, timeout=10).status_code == 200

    # Supabase-style paths without the project id (services pick the domain up via odb:domains-changed)
    for _ in range(30):
        r = via(dom, "/rest/v1/things?select=id,name", headers={"apikey": dom.anon_key})
        if r.status_code == 200:
            break
        time.sleep(0.5)
    assert r.status_code == 200 and r.json() == [{"id": 1, "name": "one"}], r.text
    # paths that include the project id keep working
    assert via(dom, f"/rest/v1/{dom.id}/things", headers={"apikey": dom.anon_key}).status_code == 200

    # auth, storage, functions, realtime
    email = f"cd-{secrets.token_hex(4)}@example.com"
    r = via(dom, "/auth/v1/signup", method="POST", headers={"apikey": dom.anon_key}, json={"email": email, "password": "password-123"})
    assert r.status_code == 200 and r.json()["user"]["email"] == email, r.text
    assert via(dom, "/storage/v1/bucket", headers={"apikey": dom.service_key}).status_code == 200
    dom.owner.post(f"/projects/{dom.id}/functions", json={"slug": "hi", "code": "export default () => 'hi from fn'", "verify_jwt": False})
    r = via(dom, "/functions/v1/hi", headers={"apikey": dom.anon_key})
    assert r.status_code == 200 and r.json() == "hi from fn", r.text
    ws = websocket.create_connection(f"{URLS['realtime']}?apikey={dom.anon_key}", host=dom.domain, timeout=10)
    try:
        hello = json.loads(ws.recv())
        assert hello["type"] == "connected" and hello["project_id"] == dom.id, hello
    finally:
        ws.close()


def test_other_projects_keys_do_not_work_on_a_domain(dom, owner):
    dom.admin.post(f"/projects/{dom.id}/domains/{dom.domain_id}/force-verify")
    other = create_project(owner, "Other")
    time.sleep(1)
    r = via(dom, "/rest/v1/things", headers={"apikey": other.anon_key})
    assert r.status_code == 401, r.text


def test_remove_stops_routing(dom):
    dom.admin.post(f"/projects/{dom.id}/domains/{dom.domain_id}/force-verify")
    assert dom.owner.delete(f"/projects/{dom.id}/domains/{dom.domain_id}").status_code == 200
    assert requests.get(f"{URLS['api']}/api/internal/domains/check", params={"domain": dom.domain}, timeout=10).status_code == 404
    wait_until(lambda: via(dom, "/rest/v1/things", headers={"apikey": dom.anon_key}).status_code == 404, timeout=10, message="unrouted")


def test_validation(dom, owner):
    for bad in ["localhost", "not a host", "-bad.example.com", "example", "a" * 64 + ".example.com"]:
        assert dom.owner.post(f"/projects/{dom.id}/domains", json={"hostname": bad}).status_code == 400, bad
    assert dom.owner.post(f"/projects/{dom.id}/domains", json={"hostname": dom.domain}).status_code == 409
    other = create_project(owner, "Other 2")
    assert other.owner.post(f"/projects/{other.id}/domains", json={"hostname": dom.domain}).status_code == 409
