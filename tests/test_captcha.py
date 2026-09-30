"""Bot protection: CAPTCHA (Cloudflare Turnstile / hCaptcha) on auth endpoints.

Uses Cloudflare's published Turnstile test secrets (always pass / always fail), so the
auth service really calls Cloudflare; skipped when it cannot reach the internet.
"""
import uuid

import pytest
from odb import create_project

PASS_SECRET = "1x0000000000000000000000000000000AA"
FAIL_SECRET = "2x0000000000000000000000000000000AA"
TOKEN = "XXXX.DUMMY.TOKEN.XXXX"


def email():
    return f"cap-{uuid.uuid4().hex[:8]}@example.com"


@pytest.fixture()
def cap(owner):
    p = create_project(owner, "Captcha")
    assert p.owner.put(f"/projects/{p.id}/auth-config", json={"captcha": {"enabled": True, "provider": "turnstile"}}).status_code == 400  # no secret
    r = p.owner.put(f"/projects/{p.id}/auth-config", json={"captcha": {"enabled": True, "provider": "turnstile", "secret": PASS_SECRET}})
    assert r.status_code == 200 and r.json()["captcha"]["secret"] == "••••••••", r.text
    return p


def signup(p, **extra):
    return p.auth("POST", "signup", json={"email": email(), "password": "password-123", **extra})


def reachable(r):
    if r.status_code == 503 and r.json().get("error") == "Captcha Unavailable":
        pytest.skip("the auth service cannot reach Cloudflare")
    return r


def test_captcha_required_on_auth_endpoints(cap):
    r = signup(cap)
    assert r.status_code == 400 and r.json()["error"] == "Captcha Required", r.text
    assert reachable(signup(cap, captcha_token=TOKEN)).status_code == 200
    # supabase-js sends it as gotrue_meta_security
    e = email()
    r = reachable(cap.auth("POST", "signup", json={"email": e, "password": "password-123", "gotrue_meta_security": {"captcha_token": TOKEN}}))
    assert r.status_code == 200, r.text

    assert cap.auth("POST", "token?grant_type=password", json={"email": e, "password": "password-123"}).status_code == 400
    s = cap.auth("POST", "token?grant_type=password", json={"email": e, "password": "password-123", "captcha_token": TOKEN})
    assert s.status_code == 200, s.text
    assert cap.auth("POST", "otp", json={"email": e}).status_code == 400
    assert cap.auth("POST", "otp", json={"email": e, "captcha_token": TOKEN}).status_code == 200
    assert cap.auth("POST", "recover", json={"email": e}).status_code == 400
    assert cap.auth("POST", "recover", json={"email": e, "captcha_token": TOKEN}).status_code == 200
    # refreshing a session and trusted server calls are exempt
    assert cap.auth("POST", "token?grant_type=refresh_token", json={"refresh_token": s.json()["refresh_token"]}).status_code == 200
    assert cap.auth("POST", "signup", key=cap.service_key, json={"email": email(), "password": "password-123"}).status_code == 200


def test_failed_captcha_is_rejected(cap):
    cap.owner.put(f"/projects/{cap.id}/auth-config", json={"captcha": {"secret": FAIL_SECRET}})
    r = reachable(signup(cap, captcha_token=TOKEN))
    assert r.status_code == 400 and r.json()["error"] == "Captcha Failed", r.text
    # sending the masked secret back keeps the stored one; switching off lifts the requirement
    cap.owner.put(f"/projects/{cap.id}/auth-config", json={"captcha": {"enabled": False, "secret": "••••••••"}})
    assert signup(cap).status_code == 200
