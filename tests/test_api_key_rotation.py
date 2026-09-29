"""API key rotation: replacement keys, grace periods, immediate revocation, rotate-all."""
import time

import pytest
import requests
from odb import URLS, create_project, wait_until


@pytest.fixture()
def proj(owner):
    p = create_project(owner, "Key rotation")
    p.sql("create table kr (id int primary key); insert into kr values (1); grant select on kr to anon")
    return p


def works(p, key) -> bool:
    return requests.get(f"{URLS['rest']}/v1/{p.id}/kr", headers={"apikey": key}, timeout=10).status_code == 200


def new_key(p, name="client", type_="anon"):
    r = p.owner.post("/keys", json={"project_id": p.id, "name": name, "type": type_})
    assert r.status_code == 201, r.text
    return r.json()


def test_rotate_with_grace_period(proj):
    old = new_key(proj)
    assert works(proj, old["key"])
    r = proj.owner.post(f"/keys/{old['id']}/rotate", json={"grace_period_seconds": 3})
    assert r.status_code == 201, r.text
    rot = r.json()
    assert rot["key"] != old["key"] and rot["name"] == old["name"] and rot["type"] == "anon"
    assert rot["rotated_from"] == old["id"] and rot["previous_key"]["revoked"] is False
    # both keys work during the grace period; the old one stops afterwards (not kept alive by caches)
    assert works(proj, rot["key"]) and works(proj, old["key"])
    time.sleep(4)
    assert not works(proj, old["key"])
    assert works(proj, rot["key"])

    listed = {k["id"]: k for k in proj.owner.get(f"/keys?project_id={proj.id}").json()["data"]}
    assert listed[old["id"]]["rotated_at"] and listed[old["id"]]["usable"] is False
    assert listed[rot["id"]]["rotated_from"] == old["id"] and listed[rot["id"]]["usable"] is True
    # a key is rotated once; rotate the replacement instead
    assert proj.owner.post(f"/keys/{old['id']}/rotate", json={}).status_code == 409


def test_rotate_immediately(proj):
    old = new_key(proj, "leaked")
    assert works(proj, old["key"])                      # now cached by the data API
    rot = proj.owner.post(f"/keys/{old['id']}/rotate", json={"grace_period_seconds": 0}).json()
    assert rot["previous_key"]["revoked"] is True
    wait_until(lambda: not works(proj, old["key"]), timeout=5, message="old key refused")
    assert works(proj, rot["key"])


def test_rotate_all_project_keys(proj):
    keys = proj.owner.get(f"/keys?project_id={proj.id}").json()["data"]
    active = [k for k in keys if k["usable"]]
    r = proj.owner.post("/keys/rotate", json={"project_id": proj.id, "types": ["anon"], "grace_period_seconds": 0})
    assert r.status_code == 201, r.text
    rotated = r.json()["data"]
    assert len(rotated) == len([k for k in active if k["type"] == "anon"]) >= 1
    assert all(k["type"] == "anon" for k in rotated)
    wait_until(lambda: not works(proj, proj.anon_key), timeout=5, message="default anon key refused")
    assert works(proj, rotated[0]["key"])
    # service keys were not touched
    assert requests.get(f"{URLS['rest']}/v1/{proj.id}/kr", headers={"apikey": proj.service_key}, timeout=10).status_code == 200


def test_rotation_validation(proj):
    k = new_key(proj)
    assert proj.owner.post(f"/keys/{k['id']}/rotate", json={"grace_period_seconds": -1}).status_code == 400
    assert proj.owner.post(f"/keys/{k['id']}/rotate", json={"grace_period_seconds": 8 * 86400}).status_code == 400
    assert proj.owner.post("/keys/00000000-0000-0000-0000-000000000000/rotate", json={}).status_code == 404
    proj.owner.delete(f"/keys/{k['id']}")
    assert proj.owner.post(f"/keys/{k['id']}/rotate", json={}).status_code == 409   # revoked
