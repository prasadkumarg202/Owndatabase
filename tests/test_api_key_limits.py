"""Per-key rate limits and IP allowlists, enforced by every data-plane service."""
import pytest
import requests
from odb import URLS, create_project, wait_until


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "Key limits")
    p.sql("create table kl (id int primary key); insert into kl values (1); grant select on kl to anon")
    return p


def make_key(p, **extra):
    r = p.owner.post("/keys", json={"project_id": p.id, "name": "limited", "type": "anon", **extra})
    assert r.status_code == 201, r.text
    return r.json()


def get(p, key):
    return requests.get(f"{URLS['rest']}/v1/{p.id}/kl", headers={"apikey": key}, timeout=10)


def test_per_key_rate_limit(proj):
    k = make_key(proj, rate_limit_per_minute=3)
    assert k["rate_limit_per_minute"] == 3
    codes = [get(proj, k["key"]).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429], codes
    r = get(proj, k["key"])
    assert r.headers["X-RateLimit-Key-Limit"] == "3" and "limited to 3" in r.json()["message"]
    # other keys are unaffected
    assert get(proj, proj.anon_key).status_code == 200


def test_ip_allowlist(proj):
    k = make_key(proj, allowed_ips=["10.0.0.0/8"])          # not where the tests run from
    r = get(proj, k["key"])
    assert r.status_code == 403 and "may not be used from" in r.json()["message"], r.text
    # every service enforces it
    assert requests.post(f"{URLS['auth']}/v1/{proj.id}/signup", headers={"apikey": k["key"]},
                         json={"email": "ip@example.com", "password": "password-123"}, timeout=10).status_code == 403
    assert requests.get(f"{URLS['storage']}/v1/{proj.id}/bucket", headers={"apikey": k["key"]}, timeout=10).status_code == 403

    r = proj.owner.patch(f"/keys/{k['id']}", json={"allowed_ips": ["0.0.0.0/0", "::/0"]})
    assert r.status_code == 200 and r.json()["allowed_ips"] == ["0.0.0.0/0", "::/0"]
    wait_until(lambda: get(proj, k["key"]).status_code == 200, timeout=5, message="allowlist refreshed")
    proj.owner.patch(f"/keys/{k['id']}", json={"allowed_ips": []})
    wait_until(lambda: get(proj, k["key"]).status_code == 200, timeout=5)


def test_validation_and_rotation_keeps_limits(proj):
    for bad in [["not-an-ip"], ["10.0.0.0/33"], ["::1/129"], ["1.2.3.4/8/9"]]:
        assert proj.owner.post("/keys", json={"project_id": proj.id, "name": "x", "type": "anon", "allowed_ips": bad}).status_code == 400, bad
    assert proj.owner.post("/keys", json={"project_id": proj.id, "name": "x", "type": "anon", "rate_limit_per_minute": 0}).status_code == 400
    k = make_key(proj, rate_limit_per_minute=50, allowed_ips=["192.0.2.0/24"])
    rot = proj.owner.post(f"/keys/{k['id']}/rotate", json={"grace_period_seconds": 0}).json()
    assert rot["rate_limit_per_minute"] == 50 and rot["allowed_ips"] == ["192.0.2.0/24"]
    listed = next(x for x in proj.owner.get(f"/keys?project_id={proj.id}").json()["data"] if x["id"] == rot["id"])
    assert listed["allowed_ips"] == ["192.0.2.0/24"]
    assert proj.owner.patch(f"/keys/{k['id']}", json={"type": "service_role"}).status_code == 400   # unknown field
