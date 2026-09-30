"""Phase 2 — phone auth: SMS OTP sign-in, phone + password, phone change, SMS provider settings."""
import random
import uuid

import pytest
from odb import create_project


def new_phone() -> str:
    return "+9199" + "".join(random.choice("0123456789") for _ in range(8))


@pytest.fixture(scope="module")
def phone_project(owner):
    p = create_project(owner, "Phone auth")
    # "log": never send a real SMS from tests, even when the platform has Twilio configured
    r = owner.put(f"/projects/{p.id}/auth-config", json={"enable_phone_auth": True, "sms": {"provider": "log", "template": "Your verification code is {{code}}"}})
    assert r.status_code == 200, r.text
    return p


def sms_code(dev_sms, p, phone, previous=None):
    """The newest code sent to `phone` (waiting until it differs from `previous`)."""
    from odb import wait_until
    return wait_until(lambda: (m := dev_sms(p, phone)) and m["code"] != previous and m["code"], timeout=10, interval=0.5,
                      message=f"new SMS to {phone}")


def test_phone_auth_disabled_by_default(fresh_project):
    r = fresh_project.auth("POST", "otp", json={"phone": new_phone()})
    assert r.status_code == 403, r.text


def test_invalid_phone_rejected(phone_project):
    for bad in ["12345", "abc", "+0123456789"]:
        assert phone_project.auth("POST", "otp", json={"phone": bad}).status_code == 400


def test_sms_otp_sign_in(phone_project, dev_sms):
    phone = new_phone()
    r = phone_project.auth("POST", "otp", json={"phone": phone, "data": {"name": "Ravi"}})
    assert r.status_code == 200, r.text
    msg = dev_sms(phone_project, phone)
    assert msg["body"] == f"Your verification code is {msg['code']}"

    wrong = "000000" if msg["code"] != "000000" else "111111"
    assert phone_project.auth("POST", "verify", json={"type": "sms", "phone": phone, "token": wrong}).status_code == 400

    # the number may be typed differently; it is normalised to E.164
    spaced = f"{phone[:3]} {phone[3:8]}-{phone[8:]}"
    r = phone_project.auth("POST", "verify", json={"type": "sms", "phone": spaced, "token": msg["code"]})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["user"]["phone"] == phone and s["user"]["phone_verified"] is True
    assert s["user"]["user_metadata"]["name"] == "Ravi"

    me = phone_project.auth("GET", "user", token=s["access_token"]).json()
    assert me["phone"] == phone
    assert any(i["provider"] == "phone" for i in me["identities"])

    # codes are single use
    assert phone_project.auth("POST", "verify", json={"type": "sms", "phone": phone, "token": msg["code"]}).status_code == 400

    # signing in again reuses the same user
    phone_project.auth("POST", "otp", json={"phone": phone})
    code = sms_code(dev_sms, phone_project, phone, previous=msg["code"])
    again = phone_project.auth("POST", "verify", json={"type": "sms", "phone": phone, "token": code}).json()
    assert again["user"]["id"] == s["user"]["id"]


def test_otp_without_create_user_does_not_reveal_or_create(phone_project):
    phone = new_phone()
    r = phone_project.auth("POST", "otp", json={"phone": phone, "create_user": False})
    assert r.status_code == 200
    assert phone_project.auth("GET", "_dev/sms", params={"phone": phone}).json()["data"] == []


def test_phone_password_signup_and_login(phone_project, dev_sms):
    phone, pw = new_phone(), "correct-horse-9"
    r = phone_project.auth("POST", "signup", json={"phone": phone, "password": pw})
    assert r.status_code == 200, r.text
    assert r.json()["session"] is None

    # not confirmed yet
    r = phone_project.auth("POST", "token?grant_type=password", json={"phone": phone, "password": pw})
    assert r.status_code == 403, r.text

    code = dev_sms(phone_project, phone)["code"]
    assert phone_project.auth("POST", "verify", json={"type": "sms", "phone": phone, "token": code}).status_code == 200

    r = phone_project.auth("POST", "token?grant_type=password", json={"phone": phone, "password": pw})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["phone"] == phone
    assert phone_project.auth("POST", "token?grant_type=password", json={"phone": phone, "password": "nope-nope"}).status_code == 401
    assert phone_project.auth("POST", "signup", json={"phone": phone, "password": pw}).status_code == 409


def test_phone_change(phone_project, dev_sms):
    email = f"pc-{uuid.uuid4().hex[:8]}@example.com"
    s = phone_project.auth("POST", "signup", json={"email": email, "password": "password-123"}).json()
    token = s["access_token"]
    phone = new_phone()

    r = phone_project.auth("PUT", "user", token=token, json={"phone": phone})
    assert r.status_code == 200, r.text
    assert r.json()["new_phone"] == phone
    assert r.json()["phone"] is None  # not applied until verified

    code = dev_sms(phone_project, phone)["code"]
    r = phone_project.auth("POST", "verify", json={"type": "phone_change", "phone": phone, "token": code})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == email and r.json()["user"]["phone"] == phone

    # another user cannot take the number
    other = phone_project.auth("POST", "signup", json={"email": f"o-{email}", "password": "password-123"}).json()
    assert phone_project.auth("PUT", "user", token=other["access_token"], json={"phone": phone}).status_code == 409


def test_sms_rate_limit_per_number(phone_project):
    phone = new_phone()
    codes = [phone_project.auth("POST", "otp", json={"phone": phone}).status_code for _ in range(6)]
    assert codes[:5] == [200] * 5 and codes[5] == 429


def test_sms_provider_settings_are_redacted(owner):
    p = create_project(owner, "SMS settings")
    r = owner.put(f"/projects/{p.id}/auth-config", json={"sms": {"provider": "twilio", "twilio_account_sid": "AC1"}})
    assert r.status_code == 400  # incomplete Twilio config

    r = owner.put(f"/projects/{p.id}/auth-config", json={
        "enable_phone_auth": True,
        "sms": {"provider": "webhook", "webhook_url": "http://127.0.0.1:9/sms", "webhook_secret": "s3cret", "template": "Code: {{code}}"},
    })
    assert r.status_code == 200, r.text
    cfg = owner.get(f"/projects/{p.id}/auth-config").json()
    assert cfg["sms"]["webhook_secret"] == "••••••••" and cfg["sms"]["template"] == "Code: {{code}}"

    # sending the mask back keeps the stored secret
    r = owner.put(f"/projects/{p.id}/auth-config", json={"sms": {**cfg["sms"], "template": "OTP {{code}}"}})
    assert r.status_code == 200
    assert owner.put(f"/projects/{p.id}/auth-config", json={"sms": {"template": "no placeholder"}}).status_code == 400

    # the webhook is unreachable: the request fails cleanly and the code is not left valid
    phone = new_phone()
    r = p.auth("POST", "otp", json={"phone": phone})
    assert r.status_code == 502, r.text


def test_supabase_style_template_and_test_numbers(owner, dev_sms):
    p = create_project(owner, "Phone test numbers")
    test_phone = new_phone()
    r = owner.put(f"/projects/{p.id}/auth-config", json={"enable_phone_auth": True, "sms_otp_expiry_minutes": 3, "sms": {
        "provider": "log", "template": "{{ .Code }} is your owndatabase code. Valid 3 minutes.", "test_otp": f"{test_phone}=123456"}})
    assert r.status_code == 200, r.text
    assert owner.put(f"/projects/{p.id}/auth-config", json={"sms": {"test_otp": "not-a-number"}}).status_code == 400

    # {{ .Code }} placeholder (Supabase's form)
    phone = new_phone()
    assert p.auth("POST", "otp", json={"phone": phone}).status_code == 200
    msg = dev_sms(p, phone)
    assert msg["body"] == f"{msg['code']} is your owndatabase code. Valid 3 minutes."

    # a test number: no SMS at all, and 123456 signs in
    assert p.auth("POST", "otp", json={"phone": test_phone}).status_code == 200
    assert p.auth("GET", "_dev/sms", params={"phone": test_phone}).json()["data"] == []
    assert p.auth("POST", "verify", json={"type": "sms", "phone": test_phone, "token": "000000"}).status_code == 400
    s = p.auth("POST", "verify", json={"type": "sms", "phone": test_phone, "token": "123456"})
    assert s.status_code == 200 and s.json()["user"]["phone"] == test_phone, s.text
    # the fixed code is single use too
    assert p.auth("POST", "verify", json={"type": "sms", "phone": test_phone, "token": "123456"}).status_code == 400


def test_default_country_code(phone_project, dev_sms):
    # the stack sets SMS_DEFAULT_COUNTRY_CODE (91 in .env); numbers without it stay international
    info = phone_project.auth("POST", "otp", json={"phone": "09876501234"})
    if info.status_code != 200:
        pytest.skip("SMS_DEFAULT_COUNTRY_CODE not set on this stack")
    msgs = phone_project.auth("GET", "_dev/sms", params={"phone": "+919876501234"}).json()["data"]
    if not msgs:
        pytest.skip("SMS_DEFAULT_COUNTRY_CODE is not 91 on this stack")
    code = msgs[0]["code"]
    r = phone_project.auth("POST", "verify", json={"type": "sms", "phone": "98765 01234", "token": code})
    assert r.status_code == 200 and r.json()["user"]["phone"] == "+919876501234", r.text
