"""Platform (dashboard) accounts, organizations and sessions."""
import requests
from odb import URLS, signup_platform_user


def test_signup_creates_personal_org(owner):
    orgs = owner.get("/organizations").json()["data"]
    assert len(orgs) >= 1
    assert orgs[0]["member_role"] == "owner"


def test_duplicate_signup_rejected(owner):
    r = requests.post(f"{URLS['api']}/api/auth/signup", json={"email": owner.email, "password": "whatever123"}, timeout=10)
    assert r.status_code == 409


def test_wrong_password_rejected(owner):
    r = requests.post(f"{URLS['api']}/api/auth/login", json={"email": owner.email, "password": "nope-nope"}, timeout=10)
    assert r.status_code == 401


def test_requires_token():
    assert requests.get(f"{URLS['api']}/api/projects", timeout=10).status_code == 401


def test_me(owner):
    r = owner.get("/auth/me")
    assert r.status_code == 200 and r.json()["email"] == owner.email


def test_refresh_rotates_and_logout_revokes():
    u = signup_platform_user("rot")
    r = requests.post(f"{URLS['api']}/api/auth/refresh", json={"refresh_token": u.refresh_token}, timeout=10)
    assert r.status_code == 200
    new = r.json()
    # old refresh token is single-use
    again = requests.post(f"{URLS['api']}/api/auth/refresh", json={"refresh_token": u.refresh_token}, timeout=10)
    assert again.status_code == 401
    u.token = new["access_token"]
    assert u.get("/auth/me").status_code == 200
    assert u.post("/auth/logout").status_code == 200
    assert u.get("/auth/me").status_code == 401


def test_org_members_and_roles(owner):
    other = signup_platform_user("dev")
    org = owner.get("/organizations").json()["data"][0]
    r = owner.post(f"/organizations/{org['id']}/members", json={"email": other.email, "role": "viewer"})
    assert r.status_code == 201
    # viewer sees the org's projects but cannot create one
    r = other.post("/projects", json={"name": "nope", "organization_id": org["id"]})
    assert r.status_code == 403
    detail = owner.get(f"/organizations/{org['id']}").json()
    assert other.email in [m["email"] for m in detail["members"]]
    # last owner cannot be removed
    me = next(m for m in detail["members"] if m["email"] == owner.email)
    assert owner.delete(f"/organizations/{org['id']}/members/{me['id']}").status_code == 409
    assert owner.delete(f"/organizations/{org['id']}/members/{detail['members'][-1]['id']}").status_code in (200, 409)


def test_other_users_cannot_see_project(project):
    stranger = signup_platform_user("stranger")
    assert stranger.get(f"/projects/{project.id}").status_code == 404
    assert stranger.post(f"/projects/{project.id}/execute", json={"query": "select 1"}).status_code == 404
    assert stranger.get(f"/keys?project_id={project.id}").status_code == 404
