"""SSO with SAML 2.0 (signInWithSSO): provider admin API, SP metadata, the sign-in round trip against
tests/mock_saml_idp.py, and the checks that must reject forged, replayed or foreign responses."""
import base64
import hashlib
import secrets
import time
from urllib.parse import parse_qs, urlparse

import pytest
import requests
from helpers import jwt_claims
from odb import URLS, create_project

mock_saml_idp = pytest.importorskip("mock_saml_idp")

SITE = "http://app.example.com"
DOMAIN = "corp-sso.example.com"


@pytest.fixture(scope="module")
def setup(owner):
    p = create_project(owner, "sso")
    assert owner.put(f"/projects/{p.id}/auth-config", json={"site_url": SITE}).status_code == 200
    time.sleep(0.3)
    idp = mock_saml_idp.MockIdP()
    r = p.auth("POST", "admin/sso/providers", key=p.service_key, json={
        "type": "saml", "metadata_xml": idp.metadata(), "domains": [DOMAIN],
        "attribute_mapping": {"keys": {"name": {"name": "displayName"}, "department": {"name": "department"}}}})
    assert r.status_code == 201, r.text
    return p, idp, r.json()["id"]


def start(p, **extra):
    body = {"domain": DOMAIN, "redirect_to": f"{SITE}/after", "skip_http_redirect": True, **extra}
    r = p.auth("POST", "sso", json=body)
    assert r.status_code == 200, r.text
    return r.json()["url"]


def acs(p, relay, saml_response):
    return requests.post(f"{URLS['auth']}/v1/{p.id}/sso/saml/acs", data={"SAMLResponse": saml_response, "RelayState": relay},
                         allow_redirects=False, timeout=20)


def fragment(loc):
    return {k: v[0] for k, v in parse_qs(loc.split("#", 1)[1]).items()}


def test_admin_api_and_metadata(setup):
    p, idp, pid = setup
    items = p.auth("GET", "admin/sso/providers", key=p.service_key).json()["items"]
    assert [i["id"] for i in items] == [pid] and items[0]["saml"]["entity_id"] == idp.entity_id
    assert items[0]["domains"] == [{"domain": DOMAIN}]
    # anon keys cannot manage providers
    assert p.auth("GET", "admin/sso/providers").status_code in (401, 403)
    # bad metadata is refused; a domain can belong to one provider only
    assert p.auth("POST", "admin/sso/providers", key=p.service_key, json={"metadata_xml": "<x/>"}).status_code == 400
    other = mock_saml_idp.MockIdP()
    assert p.auth("POST", "admin/sso/providers", key=p.service_key, json={"metadata_xml": other.metadata(), "domains": [DOMAIN]}).status_code == 409
    # metadata URLs must be public https
    assert p.auth("POST", "admin/sso/providers", key=p.service_key, json={"metadata_url": "http://127.0.0.1/metadata"}).status_code == 400
    md = requests.get(f"{URLS['auth']}/v1/{p.id}/sso/saml/metadata", timeout=10)
    assert md.status_code == 200 and f"/v1/{p.id}/sso/saml/acs" in md.text and "WantAssertionsSigned=\"true\"" in md.text


def test_sign_in_round_trip(setup):
    p, idp, pid = setup
    url = start(p)
    assert url.startswith(idp.sso_url)
    req = idp.read_request(url)
    assert req["sp"].endswith(f"/v1/{p.id}/sso/saml/metadata")
    r = acs(p, req["relay"], idp.response(req, f"alice@{DOMAIN}"))
    assert r.status_code == 302 and r.headers["location"].startswith(f"{SITE}/after#access_token="), r.headers.get("location")
    f = fragment(r.headers["location"])
    me = p.auth("GET", "user", token=f["access_token"]).json()
    assert me["email"] == f"alice@{DOMAIN}" and me["email_verified"] is True
    assert me["identities"][0]["provider"] == f"sso:{pid}"
    assert me["user_metadata"]["full_name"] == "Alice Example"
    assert jwt_claims(f["access_token"])["amr"][0]["method"] == "sso/saml"
    # the same person signs in again: same user
    req2 = idp.read_request(start(p))
    f2 = fragment(acs(p, req2["relay"], idp.response(req2, f"alice@{DOMAIN}")).headers["location"])
    assert jwt_claims(f2["access_token"])["sub"] == me["id"]


def test_pkce_flow(setup):
    p, idp, _ = setup
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    req = idp.read_request(start(p, code_challenge=challenge, code_challenge_method="s256"))
    loc = acs(p, req["relay"], idp.response(req, f"bob@{DOMAIN}")).headers["location"]
    code = parse_qs(urlparse(loc).query)["code"][0]
    s = p.auth("POST", "token?grant_type=pkce", json={"auth_code": code, "code_verifier": verifier})
    assert s.status_code == 200 and s.json()["user"]["email"] == f"bob@{DOMAIN}", s.text


def rejected(r):
    loc = r.headers.get("location", "")
    return r.status_code == 302 and "error=" in loc and "access_token" not in loc


def test_forged_and_foreign_responses_are_rejected(setup):
    p, idp, _ = setup
    # signed by another key
    req = idp.read_request(start(p))
    key, cert = mock_saml_idp.new_keypair("attacker")
    assert rejected(acs(p, req["relay"], idp.response(req, f"eve@{DOMAIN}", key=key, cert=cert)))
    # changed after signing
    req = idp.read_request(start(p))
    assert rejected(acs(p, req["relay"], idp.response(req, f"carol@{DOMAIN}", tamper=lambda d: d.replace(f"carol@{DOMAIN}", f"admin@{DOMAIN}"))))
    # for another service provider
    req = idp.read_request(start(p))
    assert rejected(acs(p, req["relay"], idp.response(req, f"dave@{DOMAIN}", audience="https://other-sp.example.com")))
    # an email outside the IdP's domains
    req = idp.read_request(start(p))
    r = acs(p, req["relay"], idp.response(req, "victim@gmail.com"))
    assert rejected(r) and "may+not+sign+in" in r.headers["location"].replace("%20", "+")
    # not answering our request / replayed
    req = idp.read_request(start(p))
    good = idp.response(req, f"frank@{DOMAIN}")
    other = idp.read_request(start(p))
    assert rejected(acs(p, other["relay"], good))                   # answers a different request
    # a response is accepted at most once: the attempt above used up its request id
    assert rejected(acs(p, req["relay"], good))
    # a response that did sign someone in cannot be replayed
    req = idp.read_request(start(p))
    once = idp.response(req, f"grace@{DOMAIN}")
    assert not rejected(acs(p, req["relay"], once))
    assert rejected(acs(p, req["relay"], once))
    # unknown relay state
    assert rejected(acs(p, "00000000-0000-0000-0000-000000000000", good))


def test_sign_in_by_provider_id_and_unknown_domain(setup):
    p, idp, pid = setup
    assert p.auth("POST", "sso", json={"provider_id": pid, "skip_http_redirect": True}).status_code == 200
    assert p.auth("POST", "sso", json={"domain": "unknown.example.com", "skip_http_redirect": True}).status_code == 404
    # without skip_http_redirect: a 303 to the IdP
    r = p.auth("POST", "sso", json={"domain": DOMAIN})
    assert r.status_code == 303 and r.headers["location"].startswith(idp.sso_url)
