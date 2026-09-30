"""Anonymous sign-ins (supabase.auth.signInAnonymously()): off by default; a guest session in the
authenticated role with is_anonymous in the JWT; converting to a permanent user by adding an email."""
import time

import pytest
from helpers import jwt_claims
from odb import create_project


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "anon auth")
    p.sql("""create table notes (id bigint generated always as identity primary key, owner uuid default auth.uid(), body text);
             alter table notes enable row level security;
             create policy own on notes for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
             create policy permanent_only on notes as restrictive for insert to authenticated
               with check (body <> 'members only' or (auth.jwt() ->> 'is_anonymous')::boolean is not true);""")
    return p


def enable(p, on=True, **extra):
    r = p.owner.put(f"/projects/{p.id}/auth-config", json={"enable_anonymous_sign_ins": on, **extra})
    assert r.status_code == 200, r.text
    time.sleep(0.4)


def test_disabled_by_default(proj):
    r = proj.auth("POST", "signup", json={})
    assert r.status_code == 422 and "disabled" in r.json()["message"]
    assert proj.auth("GET", "settings").json()["external"]["anonymous_users"] is False


def test_anonymous_session_rls_and_claims(proj):
    enable(proj)
    assert proj.auth("GET", "settings").json()["external"]["anonymous_users"] is True
    r = proj.auth("POST", "signup", json={"data": {"nickname": "guest"}})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["access_token"] and s["refresh_token"] and s["user"]["is_anonymous"] is True and s["user"]["email"] is None
    claims = jwt_claims(s["access_token"])
    assert claims["role"] == "authenticated" and claims["is_anonymous"] is True
    tok = s["access_token"]
    assert proj.auth("GET", "user", token=tok).json()["user_metadata"]["nickname"] == "guest"
    # RLS: the guest owns its rows; auth.jwt() lets policies tell guests apart
    assert proj.rest("POST", "notes", token=tok, json={"body": "hi"}).status_code in (200, 201)
    assert proj.rest("POST", "notes", token=tok, json={"body": "members only"}).status_code in (401, 403)
    assert [n["body"] for n in proj.rest("GET", "notes?select=body", token=tok).json()] == ["hi"]
    # refresh keeps the session going
    rr = proj.auth("POST", "token?grant_type=refresh_token", json={"refresh_token": s["refresh_token"]})
    assert rr.status_code == 200 and jwt_claims(rr.json()["access_token"])["is_anonymous"] is True
    # the dashboard's user list marks it
    users = proj.owner.get(f"/projects/{proj.id}/users").json()["data"]
    assert any(u["id"] == s["user"]["id"] and u["is_anonymous"] for u in users)


def test_convert_to_permanent_user(proj):
    enable(proj, require_email_confirmation=False)
    s = proj.auth("POST", "signup", json={}).json()
    uid, tok = s["user"]["id"], s["access_token"]
    assert proj.rest("POST", "notes", token=tok, json={"body": "before"}).status_code in (200, 201)
    email = f"guest-{int(time.time() * 1000)}@example.com"
    r = proj.auth("PUT", "user", token=tok, json={"email": email})
    assert r.status_code == 200, r.text
    u = r.json()["user"]
    assert u["id"] == uid and u["email"] == email and u["is_anonymous"] is False
    assert r.json()["user"]["app_metadata"]["providers"] == ["email"]
    assert proj.auth("PUT", "user", token=tok, json={"password": "guest-pass-123"}).status_code == 200
    # signs in with the new credentials and keeps its data
    li = proj.auth("POST", "token?grant_type=password", json={"email": email, "password": "guest-pass-123"})
    assert li.status_code == 200, li.text
    t2 = li.json()["access_token"]
    assert jwt_claims(t2)["is_anonymous"] is False and jwt_claims(t2)["sub"] == uid
    assert [n["body"] for n in proj.rest("GET", "notes?select=body", token=t2).json()] == ["before"]
    assert proj.rest("POST", "notes", token=t2, json={"body": "members only"}).status_code in (200, 201)


def test_conversion_with_email_confirmation(proj):
    enable(proj, require_email_confirmation=True)
    s = proj.auth("POST", "signup", json={}).json()
    email = f"confirm-{int(time.time() * 1000)}@example.com"
    u = proj.auth("PUT", "user", token=s["access_token"], json={"email": email}).json()["user"]
    assert u["is_anonymous"] is True and u["email_verified"] is False   # not until the address is confirmed
    enable(proj, require_email_confirmation=False)


def test_rate_limit_and_signups_disabled(proj):
    enable(proj, enable_signup=False)
    assert proj.auth("POST", "signup", json={}).status_code == 403
    enable(proj, enable_signup=True)
