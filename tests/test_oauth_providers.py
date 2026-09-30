"""OAuth providers against tests/mock_oidc.py: the redirect flow for each provider, Apple's form_post,
the supabase-js PKCE flow (grant_type=pkce), native id_token sign-in and account linking.

Needs the auth service to run with OAUTH_MOCK_URL=http://host.docker.internal:9912 and
OAUTH_MOCK_PUBLIC_URL=http://localhost:9912 (see .env); skipped otherwise."""
import base64
import hashlib
import os
import secrets
import time
from urllib.parse import parse_qs, urlparse

import pytest
import requests
from odb import URLS, create_project

mock_oidc = pytest.importorskip("mock_oidc")

SITE = "http://app.example.com"
PORT = int(os.environ.get("ODB_MOCK_OIDC_PORT", "9912"))


@pytest.fixture(scope="module")
def mock():
    try:
        m = mock_oidc.MockOIDC(PORT, docker_host=os.environ.get("ODB_WEBHOOK_HOST", "host.docker.internal"))
    except OSError:
        pytest.skip(f"port {PORT} busy")
    yield m
    m.close()


@pytest.fixture(scope="module")
def proj(owner, mock):
    p = create_project(owner, "oauth providers")
    providers = {name: {"enabled": True, "client_id": f"{name}-client", "client_secret": "mock-secret"}
                 for name in ["google", "gitlab", "bitbucket", "azure", "apple", "facebook", "discord", "linkedin_oidc",
                              "slack_oidc", "x", "spotify", "twitch", "keycloak"]}
    providers["google"]["additional_client_ids"] = "ios-client, android-client"
    providers["keycloak"]["url"] = "https://sso.example.com/realms/main"
    r = owner.put(f"/projects/{p.id}/auth-config", json={"site_url": SITE, "providers": providers})
    assert r.status_code == 200, r.text
    assert r.json()["providers"]["apple"]["client_secret"] == "••••••••"
    time.sleep(0.3)
    r = p.auth("GET", f"authorize?provider=google&redirect_to={SITE}/cb")
    if f":{PORT}/" not in r.headers.get("location", ""):
        pytest.skip("auth service is not using the mock provider (set OAUTH_MOCK_URL / OAUTH_MOCK_PUBLIC_URL)")
    return p


def run_flow(p, provider, query="", post=False, form_extra=None):
    """authorize → mock provider → callback; returns (final redirect location, authorize URL)."""
    r = requests.get(f"{URLS['auth']}/v1/{p.id}/authorize?provider={provider}&redirect_to={SITE}/cb{query}", allow_redirects=False, timeout=10)
    assert r.status_code == 302, r.text
    auth_url = r.headers["location"]
    cb = requests.get(auth_url, allow_redirects=False, timeout=10).headers["location"]
    path = cb.split(f"/v1/{p.id}/", 1)[1]
    if post:
        q = {k: v[0] for k, v in parse_qs(urlparse(cb).query).items()}
        done = requests.post(f"{URLS['auth']}/v1/{p.id}/callback", data={**q, **(form_extra or {})}, allow_redirects=False, timeout=15)
    else:
        done = requests.get(f"{URLS['auth']}/v1/{p.id}/{path}", allow_redirects=False, timeout=15)
    assert done.status_code == 302, done.text
    return done.headers["location"], auth_url


def fragment(loc):
    return {k: v[0] for k, v in parse_qs(loc.split("#", 1)[1]).items()}


EXPECT_VERIFIED = {"spotify": False}


@pytest.mark.parametrize("provider", ["google", "gitlab", "bitbucket", "azure", "facebook", "discord", "linkedin_oidc",
                                      "slack_oidc", "x", "spotify", "twitch", "keycloak"])
def test_provider_flow(proj, mock, provider):
    loc, auth_url = run_flow(proj, provider)
    assert loc.startswith(f"{SITE}/cb#access_token="), loc
    f = fragment(loc)
    assert f["provider"] == provider and f["provider_token"].startswith("mock-access-") and int(f["expires_at"]) > time.time()
    me = proj.auth("GET", "user", token=f["access_token"]).json()
    person = mock.person(provider)
    assert me["email"] == person["email"]
    assert me["identities"][0]["provider"] == provider
    assert me["user_metadata"]["full_name"] == person["name"]
    assert bool(me.get("email_confirmed_at") or me.get("email_verified")) == EXPECT_VERIFIED.get(provider, True), me
    # PKCE towards the provider where it is supported; Basic client auth where required
    q = parse_qs(urlparse(auth_url).query)
    assert ("code_challenge" in q) == (provider not in ("bitbucket", "linkedin_oidc", "slack_oidc", "twitch"))
    assert q["client_id"] == [f"{provider}-client"]
    assert (mock.token_requests[-1].get("_basic") == "1") == (provider in ("bitbucket", "x"))
    # a second sign-in finds the same user through the identity
    f2 = fragment(run_flow(proj, provider)[0])
    assert proj.auth("GET", "user", token=f2["access_token"]).json()["id"] == me["id"]


def test_apple_form_post(proj, mock):
    loc, auth_url = run_flow(proj, "apple", post=True, form_extra={"user": '{"name":{"firstName":"Ada","lastName":"Lovelace"}}'})
    assert parse_qs(urlparse(auth_url).query)["response_mode"] == ["form_post"]
    f = fragment(loc)
    me = proj.auth("GET", "user", token=f["access_token"]).json()
    assert me["email"] == mock.person("apple")["email"] and me["user_metadata"]["full_name"] == "Ada Lovelace"


def test_extra_scopes_are_added(proj):
    r = requests.get(f"{URLS['auth']}/v1/{proj.id}/authorize?provider=google&scopes=https://www.googleapis.com/auth/calendar", allow_redirects=False, timeout=10)
    scope = parse_qs(urlparse(r.headers["location"]).query)["scope"][0].split(" ")
    assert {"openid", "email", "profile", "https://www.googleapis.com/auth/calendar"} <= set(scope)


def test_unknown_or_unconfigured_provider(proj, owner):
    assert proj.auth("GET", "authorize?provider=myspace").status_code == 400
    assert proj.auth("GET", "authorize?provider=github").status_code in (302, 400)  # platform env may configure github
    s = proj.auth("GET", "settings").json()
    assert s["external"]["google"] is True and s["external"]["apple"] is True and s["external"]["email"] is True


def pkce_pair():
    verifier = secrets.token_urlsafe(48)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def test_pkce_flow(proj, mock):
    v1, c1 = pkce_pair()
    loc, _ = run_flow(proj, "discord", f"&code_challenge={c1}&code_challenge_method=s256")
    assert loc.startswith(f"{SITE}/cb?code="), loc
    code = parse_qs(urlparse(loc).query)["code"][0]
    # a wrong verifier fails and burns the code
    assert proj.auth("POST", "token?grant_type=pkce", json={"auth_code": code, "code_verifier": "x" * 50}).status_code == 400
    assert proj.auth("POST", "token?grant_type=pkce", json={"auth_code": code, "code_verifier": v1}).status_code == 400
    verifier, challenge = pkce_pair()
    code = parse_qs(urlparse(run_flow(proj, "discord", f"&code_challenge={challenge}&code_challenge_method=s256")[0]).query)["code"][0]
    r = proj.auth("POST", "token?grant_type=pkce", json={"auth_code": code, "code_verifier": verifier})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["user"]["email"] == mock.person("discord")["email"] and s["provider_token"].startswith("mock-access-")
    assert proj.auth("POST", "token?grant_type=pkce", json={"auth_code": code, "code_verifier": verifier}).status_code == 400
    # errors come back in the query string for PKCE
    r = requests.get(f"{URLS['auth']}/v1/{proj.id}/authorize?provider=discord&redirect_to={SITE}/cb&code_challenge=short", allow_redirects=False, timeout=10)
    assert r.status_code == 400


def test_id_token_sign_in(proj, mock):
    nonce = secrets.token_urlsafe(16)
    hashed = hashlib.sha256(nonce.encode()).hexdigest()
    tok = mock.id_token("google", "google-client", nonce=hashed)
    r = proj.auth("POST", "token?grant_type=id_token", json={"provider": "google", "id_token": tok, "nonce": nonce})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == mock.person("google")["email"]
    # another audience from additional_client_ids (a native app's client id)
    r = proj.auth("POST", "token?grant_type=id_token", json={"provider": "google", "id_token": mock.id_token("google", "ios-client")})
    assert r.status_code == 200, r.text

    bad = {
        "wrong audience": mock.id_token("google", "someone-else"),
        "wrong issuer": mock.id_token("google", "google-client", iss="https://evil.example.com"),
        "expired": mock.id_token("google", "google-client", exp=int(time.time()) - 600, iat=int(time.time()) - 1200),
        "unknown key": mock.id_token("google", "google-client", key=mock_oidc.new_rsa_key()),
    }
    for label, t in bad.items():
        r = proj.auth("POST", "token?grant_type=id_token", json={"provider": "google", "id_token": t})
        assert r.status_code == 400, (label, r.text)
    r = proj.auth("POST", "token?grant_type=id_token", json={"provider": "google", "id_token": mock.id_token("google", "google-client", nonce=hashed), "nonce": "other"})
    assert r.status_code == 400 and "once" in r.json()["message"]
    r = proj.auth("POST", "token?grant_type=id_token", json={"provider": "google", "id_token": mock.id_token("google", "google-client", nonce=hashed)})
    assert r.status_code == 400
    # a provider without JWKS support / not configured
    assert proj.auth("POST", "token?grant_type=id_token", json={"provider": "github", "id_token": tok}).status_code == 400

    # Apple: email_verified is the string "true"
    r = proj.auth("POST", "token?grant_type=id_token", json={"provider": "apple", "id_token": mock.id_token("apple", "apple-client")})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == mock.person("apple")["email"]


def test_account_linking(owner, mock):
    p = create_project(owner, "oauth linking")
    owner.put(f"/projects/{p.id}/auth-config", json={"site_url": SITE, "require_email_confirmation": True, "providers": {
        "gitlab": {"enabled": True, "client_id": "gitlab-client", "client_secret": "mock-secret"},
        "spotify": {"enabled": True, "client_id": "spotify-client", "client_secret": "mock-secret"},
    }})
    time.sleep(0.3)
    # someone registered the address with a password but never confirmed it
    email = mock.person("gitlab")["email"]
    assert p.auth("POST", "signup", json={"email": email, "password": "attacker-pass-1"}).status_code in (200, 201)
    assert p.auth("POST", "token?grant_type=password", json={"email": email, "password": "attacker-pass-1"}).status_code == 403
    f = fragment(run_flow(p, "gitlab")[0])
    me = p.auth("GET", "user", token=f["access_token"]).json()
    assert me["email"] == email and {i["provider"] for i in me["identities"]} >= {"gitlab"}
    assert me["app_metadata"]["providers"] and "gitlab" in me["app_metadata"]["providers"]
    # the unverified password no longer works
    assert p.auth("POST", "token?grant_type=password", json={"email": email, "password": "attacker-pass-1"}).status_code in (400, 401)

    # an unverified provider email that belongs to an existing account is refused
    mock.person("spotify")["email"] = email
    loc, _ = run_flow(p, "spotify")
    assert "error=oauth_failed" in loc and "already+exists" in loc.replace("%20", "+"), loc
