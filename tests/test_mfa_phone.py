"""SMS as a second factor (supabase.auth.mfa with factorType 'phone'), and challenges for TOTP factors.
SMS codes are read from the auth service's dev mailbox (the 'log' provider: nothing is really sent)."""
import random
import time

import pytest
from helpers import jwt_claims, totp
from odb import create_project, wait_until


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "mfa phone")
    r = owner.put(f"/projects/{p.id}/auth-config", json={"enable_mfa_phone": True, "sms": {"provider": "log", "template": "Your code is {{code}}"}})
    assert r.status_code == 200, r.text
    time.sleep(0.4)
    return p


def phone():
    return f"+9198{random.randint(10000000, 99999999)}"


def code_for(dev_sms, p, number, previous=None):
    return wait_until(lambda: (m := dev_sms(p, number)) and m["code"] != previous and m["code"], timeout=10, interval=0.5, message="sms code")


def enroll(p, tok, number):
    r = p.auth("POST", "factors", token=tok, json={"factor_type": "phone", "phone": number, "friendly_name": "My phone"})
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["type"] == "phone" and f["phone"] == number and f["status"] == "unverified"
    return f["id"]


def test_enroll_challenge_verify(proj, dev_sms):
    u = proj.new_user()
    tok, number = u["access_token"], phone()
    fid = enroll(proj, tok, number)
    ch = proj.auth("POST", f"factors/{fid}/challenge", token=tok, json={})
    assert ch.status_code == 200 and ch.json()["type"] == "phone" and ch.json()["expires_at"] > time.time(), ch.text
    code = code_for(dev_sms, proj, number)
    # a phone factor needs the challenge; wrong codes are refused
    assert proj.auth("POST", f"factors/{fid}/verify", token=tok, json={"code": code}).status_code == 400
    bad = "000000" if code != "000000" else "111111"
    assert proj.auth("POST", f"factors/{fid}/verify", token=tok, json={"code": bad, "challenge_id": ch.json()["id"]}).status_code == 400
    r = proj.auth("POST", f"factors/{fid}/verify", token=tok, json={"code": code, "challenge_id": ch.json()["id"]})
    assert r.status_code == 200, r.text
    s = r.json()
    claims = jwt_claims(s["access_token"])
    assert claims["aal"] == "aal2" and claims["amr"][0]["method"] == "sms"
    # the challenge is used up
    assert proj.auth("POST", f"factors/{fid}/verify", token=tok, json={"code": code, "challenge_id": ch.json()["id"]}).status_code == 400
    factors = proj.auth("GET", "factors", token=s["access_token"]).json()
    assert [f["factor_type"] for f in factors["phone"]] == ["phone"] and factors["phone"][0]["status"] == "verified"

    # next sign-in: aal1 until the SMS code is entered
    li = proj.auth("POST", "token?grant_type=password", json={"email": u["email"], "password": u["password"]}).json()
    assert jwt_claims(li["access_token"])["aal"] == "aal1" and li.get("mfa_required") is True
    ch2 = proj.auth("POST", f"factors/{fid}/challenge", token=li["access_token"], json={}).json()
    code2 = code_for(dev_sms, proj, number, previous=code)
    s2 = proj.auth("POST", f"factors/{fid}/verify", token=li["access_token"], json={"code": code2, "challenge_id": ch2["id"]})
    assert s2.status_code == 200 and jwt_claims(s2.json()["access_token"])["aal"] == "aal2"


def test_attempts_are_limited(proj, dev_sms):
    u = proj.new_user()
    tok, number = u["access_token"], phone()
    fid = enroll(proj, tok, number)
    ch = proj.auth("POST", f"factors/{fid}/challenge", token=tok, json={}).json()
    code = code_for(dev_sms, proj, number)
    bad = "000000" if code != "000000" else "111111"
    for _ in range(5):
        assert proj.auth("POST", f"factors/{fid}/verify", token=tok, json={"code": bad, "challenge_id": ch["id"]}).status_code == 400
    # the right code no longer works on this challenge
    assert proj.auth("POST", f"factors/{fid}/verify", token=tok, json={"code": code, "challenge_id": ch["id"]}).status_code == 400


def test_validation_and_setting(proj, owner):
    u = proj.new_user()
    tok = u["access_token"]
    assert proj.auth("POST", "factors", token=tok, json={"factor_type": "phone", "phone": "12"}).status_code == 400
    assert proj.auth("POST", "factors", token=tok, json={"factor_type": "email"}).status_code == 400
    other = create_project(owner, "mfa phone off")
    v = other.new_user()
    r = other.auth("POST", "factors", token=v["access_token"], json={"factor_type": "phone", "phone": phone()})
    assert r.status_code == 403 and "disabled" in r.json()["message"]


def test_totp_challenge_for_supabase_js(proj):
    """supabase-js calls challenge before verify for TOTP too."""
    u = proj.new_user()
    tok = u["access_token"]
    f = proj.auth("POST", "factors", token=tok, json={"factor_type": "totp"}).json()
    ch = proj.auth("POST", f"factors/{f['id']}/challenge", token=tok, json={})
    assert ch.status_code == 200 and ch.json()["type"] == "totp"
    r = proj.auth("POST", f"factors/{f['id']}/verify", token=tok, json={"code": totp(f["totp"]["secret"]), "challenge_id": ch.json()["id"]})
    assert r.status_code == 200 and jwt_claims(r.json()["access_token"])["aal"] == "aal2"
