"""Phase 2 — end-user authentication: signup, login, refresh rotation, sessions, email flows, MFA, OAuth, admin, lockout."""
import os
import time
import uuid

import pytest
import requests

from odb import URLS, create_project
from helpers import MockOAuth, jwt_claims, totp


def test_requires_api_key(project):
    r = requests.post(f"{URLS['auth']}/v1/{project.id}/signup", json={"email": "a@b.co", "password": "x" * 10}, timeout=10)
    assert r.status_code == 401
    r = project.auth("POST", "signup", key="odb_anon_invalidinvalidinvalid", json={"email": "a@b.co", "password": "x" * 10})
    assert r.status_code == 401


def test_signup_login_and_token_claims(project):
    s = project.new_user()
    assert s["access_token"] and s["refresh_token"]
    claims = jwt_claims(s["access_token"])
    assert claims["project_id"] == project.id and claims["role"] == "authenticated" and claims["iss"] == "owndatabase-auth"
    r = project.auth("POST", "token?grant_type=password", json={"email": s["email"], "password": s["password"]})
    assert r.status_code == 200
    me = project.auth("GET", "user", token=r.json()["access_token"])
    assert me.status_code == 200 and me.json()["email"] == s["email"]


def test_duplicate_and_weak_password(project):
    s = project.new_user()
    assert project.auth("POST", "signup", json={"email": s["email"], "password": "another-pass"}).status_code == 409
    assert project.auth("POST", "signup", json={"email": f"w{uuid.uuid4().hex[:6]}@x.io", "password": "short"}).status_code == 422


def test_invalid_credentials(project):
    s = project.new_user()
    r = project.auth("POST", "token?grant_type=password", json={"email": s["email"], "password": "wrong-password"})
    assert r.status_code == 401


def test_refresh_rotation_and_reuse_detection(project):
    s = project.new_user()
    r1 = project.auth("POST", "token?grant_type=refresh_token", json={"refresh_token": s["refresh_token"]})
    assert r1.status_code == 200
    new = r1.json()
    assert new["refresh_token"] != s["refresh_token"]
    # re-using the old token revokes the whole session
    reuse = project.auth("POST", "refresh", json={"refresh_token": s["refresh_token"]})
    assert reuse.status_code == 401
    assert project.auth("POST", "refresh", json={"refresh_token": new["refresh_token"]}).status_code == 401


def test_logout_single_and_global(project):
    s = project.new_user()
    other = project.auth("POST", "login", json={"email": s["email"], "password": s["password"]}).json()
    assert project.auth("POST", "logout", token=s["access_token"]).status_code == 200
    assert project.auth("GET", "user", token=s["access_token"]).status_code == 401
    assert project.auth("GET", "user", token=other["access_token"]).status_code == 200
    third = project.auth("POST", "login", json={"email": s["email"], "password": s["password"]}).json()
    assert project.auth("POST", "logout?scope=global", token=third["access_token"]).status_code == 200
    assert project.auth("GET", "user", token=other["access_token"]).status_code == 401


def test_update_user_metadata_and_password(project):
    s = project.new_user()
    r = project.auth("PUT", "user", token=s["access_token"], json={"data": {"nickname": "neo"}})
    assert r.status_code == 200 and r.json()["user_metadata"]["nickname"] == "neo"
    r = project.auth("PUT", "user", token=s["access_token"], json={"password": "brand-new-password"})
    assert r.status_code == 200
    assert project.auth("POST", "login", json={"email": s["email"], "password": "brand-new-password"}).status_code == 200


def test_token_is_bound_to_project(owner, project):
    other = create_project(owner)
    s = project.new_user()
    r = other.auth("GET", "user", token=s["access_token"])
    assert r.status_code == 401
    # the same email can register independently in another project
    r = other.auth("POST", "signup", json={"email": s["email"], "password": "different-password"})
    assert r.status_code == 200


def test_public_settings(project):
    s = project.auth("GET", "settings").json()
    assert s["signup_enabled"] is True and "github" in s["external"]


def test_brute_force_lockout(owner):
    p = create_project(owner)
    assert owner.put(f"/projects/{p.id}/auth-config", json={"max_failed_logins": 3, "lockout_minutes": 1}).status_code == 200
    s = p.new_user()
    for _ in range(3):
        assert p.auth("POST", "login", json={"email": s["email"], "password": "bad-password"}).status_code == 401
    r = p.auth("POST", "login", json={"email": s["email"], "password": s["password"]})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_signup_disabled(owner):
    p = create_project(owner)
    owner.put(f"/projects/{p.id}/auth-config", json={"enable_signup": False})
    time.sleep(0.3)
    r = p.auth("POST", "signup", json={"email": f"x{uuid.uuid4().hex[:6]}@x.io", "password": "password-123"})
    assert r.status_code == 403
    # service_role can still create users
    r = p.auth("POST", "signup", key=p.service_key, json={"email": f"x{uuid.uuid4().hex[:6]}@x.io", "password": "password-123"})
    assert r.status_code == 200


@pytest.mark.devmailbox
def test_email_confirmation_flow(owner, dev_mailbox):
    p = create_project(owner)
    owner.put(f"/projects/{p.id}/auth-config", json={"require_email_confirmation": True})
    time.sleep(0.3)
    email = f"confirm-{uuid.uuid4().hex[:6]}@example.com"
    r = p.auth("POST", "signup", json={"email": email, "password": "password-123"})
    assert r.status_code == 200 and r.json()["session"] is None
    assert p.auth("POST", "login", json={"email": email, "password": "password-123"}).status_code == 403
    mail = dev_mailbox(p, email, "signup")
    bad = p.auth("POST", "verify", json={"type": "signup", "email": email, "token": "000000" if mail["meta"]["code"] != "000000" else "111111"})
    assert bad.status_code == 400
    r = p.auth("POST", "verify", json={"type": "signup", "email": email, "token": mail["meta"]["code"]})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email_verified"] is True
    assert p.auth("POST", "login", json={"email": email, "password": "password-123"}).status_code == 200


@pytest.mark.devmailbox
def test_magic_link_code(project, dev_mailbox):
    email = f"magic-{uuid.uuid4().hex[:6]}@example.com"
    assert project.auth("POST", "otp", json={"email": email}).status_code == 200
    mail = dev_mailbox(project, email, "magiclink")
    r = project.auth("POST", "verify", json={"type": "magiclink", "email": email, "token": mail["meta"]["code"]})
    assert r.status_code == 200 and r.json()["user"]["email"] == email
    # codes are single use
    again = project.auth("POST", "verify", json={"type": "magiclink", "email": email, "token": mail["meta"]["code"]})
    assert again.status_code == 400


@pytest.mark.devmailbox
def test_email_otp_verifies_with_type_email(project, dev_mailbox):
    # supabase-js: signInWithOtp({ email }) then verifyOtp({ email, token, type: 'email' })
    email = f"otp-{uuid.uuid4().hex[:6]}@example.com"
    assert project.auth("POST", "otp", json={"email": email}).status_code == 200
    mail = dev_mailbox(project, email, "magiclink")
    r = project.auth("POST", "verify", json={"type": "email", "email": email, "token": mail["meta"]["code"]})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email_verified"] is True


@pytest.mark.devmailbox
def test_magic_link_url_redirects_with_tokens(project, dev_mailbox):
    email = f"link-{uuid.uuid4().hex[:6]}@example.com"
    project.auth("POST", "otp", json={"email": email})
    mail = dev_mailbox(project, email, "magiclink")
    link = mail["text"].split("Or open: ")[1].strip()
    token = link.split("token=")[1].split("&")[0]
    r = project.auth("GET", f"verify?type=magiclink&token={token}")
    assert r.status_code == 302
    assert "#access_token=" in r.headers["location"]


@pytest.mark.devmailbox
def test_password_reset(project, dev_mailbox):
    s = project.new_user()
    assert project.auth("POST", "recover", json={"email": s["email"]}).status_code == 200
    # unknown emails get the same answer (no account enumeration)
    assert project.auth("POST", "recover", json={"email": "nobody-here@example.com"}).status_code == 200
    mail = dev_mailbox(project, s["email"], "recovery")
    r = project.auth("POST", "reset-password", json={"email": s["email"], "token": mail["meta"]["code"], "new_password": "reset-password-9"})
    assert r.status_code == 200, r.text
    assert project.auth("GET", "user", token=s["access_token"]).status_code == 401  # sessions revoked
    assert project.auth("POST", "login", json={"email": s["email"], "password": "reset-password-9"}).status_code == 200


def test_mfa_totp_enrollment_and_login(project):
    s = project.new_user()
    r = project.auth("POST", "factors", token=s["access_token"], json={"friendly_name": "phone"})
    assert r.status_code == 201, r.text
    factor = r.json()
    secret = factor["totp"]["secret"]
    assert factor["totp"]["uri"].startswith("otpauth://totp/")
    assert project.auth("POST", f"factors/{factor['id']}/verify", token=s["access_token"], json={"code": "000000" if totp(secret) != "000000" else "111111"}).status_code == 400
    r = project.auth("POST", f"factors/{factor['id']}/verify", token=s["access_token"], json={"code": totp(secret)})
    assert r.status_code == 200, r.text
    assert jwt_claims(r.json()["access_token"])["aal"] == "aal2"

    # a fresh password login is aal1 and flags that MFA is required
    login = project.auth("POST", "login", json={"email": s["email"], "password": s["password"]}).json()
    assert login["aal"] == "aal1" and login.get("mfa_required") is True
    # changing the password needs aal2
    assert project.auth("PUT", "user", token=login["access_token"], json={"password": "another-password"}).status_code == 403
    # replaying the same code is rejected; the next time-step code works
    assert project.auth("POST", f"factors/{factor['id']}/verify", token=login["access_token"], json={"code": totp(secret)}).status_code == 400
    up = project.auth("POST", f"factors/{factor['id']}/verify", token=login["access_token"], json={"code": totp(secret, step_offset=1)})
    assert up.status_code == 200 and up.json()["aal"] == "aal2"
    assert project.auth("PUT", "user", token=up.json()["access_token"], json={"password": "another-password"}).status_code == 200


def test_admin_endpoints_need_service_key(project):
    assert project.auth("GET", "admin/users").status_code == 403
    r = project.auth("POST", "admin/users", key=project.service_key, json={"email": f"adm-{uuid.uuid4().hex[:6]}@x.io", "password": "password-1", "email_confirm": True})
    assert r.status_code == 201
    uid = r.json()["id"]
    r = project.auth("PATCH", f"admin/users/{uid}", key=project.service_key, json={"ban_duration_hours": 1})
    assert r.status_code == 200
    users = project.auth("GET", "admin/users", key=project.service_key).json()["users"]
    assert any(u["id"] == uid for u in users)
    assert project.auth("DELETE", f"admin/users/{uid}", key=project.service_key).status_code == 200


def test_banned_user_cannot_login(project):
    s = project.new_user()
    uid = s["user"]["id"]
    r = project.owner.patch(f"/projects/{project.id}/users/{uid}", json={"ban_hours": 1})
    assert r.status_code == 200
    assert project.auth("POST", "login", json={"email": s["email"], "password": s["password"]}).status_code == 403
    detail = project.owner.get(f"/projects/{project.id}/users/{uid}").json()
    assert detail["user"]["banned_until"] is not None
    assert project.owner.get(f"/projects/{project.id}/users?search={s['email']}").json()["total"] == 1


@pytest.fixture(scope="module")
def mock_oauth():
    port = int(os.environ.get("ODB_MOCK_OAUTH_PORT", "9911"))
    try:
        m = MockOAuth(port)
    except OSError:
        pytest.skip(f"port {port} busy")
    yield m
    m.close()


def test_oauth_github_flow(owner, mock_oauth):
    """Requires the auth service to run with OAUTH_GITHUB_*_URL pointing at the mock provider."""
    p = create_project(owner)
    owner.put(f"/projects/{p.id}/auth-config", json={
        "site_url": "http://app.example.com",
        "providers": {"github": {"enabled": True, "client_id": "mock-client", "client_secret": "mock-secret"}},
    })
    time.sleep(0.3)
    r = p.auth("GET", "authorize?provider=github&redirect_to=http://app.example.com/after")
    assert r.status_code == 302, r.text
    auth_url = r.headers["location"]
    if f":{mock_oauth.port}/" not in auth_url:
        pytest.skip("auth service is not configured to use the mock OAuth provider (OAUTH_GITHUB_AUTHORIZE_URL)")
    assert "code_challenge=" in auth_url and "state=" in auth_url
    provider = requests.get(auth_url, allow_redirects=False, timeout=10)
    callback = provider.headers["location"]
    # the callback URL is the auth service's public URL; call it directly
    path = callback.split(f"/v1/{p.id}/", 1)[1]
    done = requests.get(f"{URLS['auth']}/v1/{p.id}/{path}", allow_redirects=False, timeout=10)
    assert done.status_code == 302, done.text
    loc = done.headers["location"]
    assert loc.startswith("http://app.example.com/after#access_token="), loc
    token = loc.split("access_token=")[1].split("&")[0]
    me = p.auth("GET", "user", token=token).json()
    assert me["email"] == mock_oauth.email and me["identities"][0]["provider"] == "github"
    # replaying the callback (state already consumed) fails
    again = requests.get(f"{URLS['auth']}/v1/{p.id}/{path}", allow_redirects=False, timeout=10)
    assert "error=" in again.headers["location"]


def test_oauth_disabled_provider(project):
    r = project.auth("GET", "authorize?provider=google")
    assert r.status_code == 400
