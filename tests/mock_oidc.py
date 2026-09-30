"""Mock identity provider for every OAuth provider at /<provider>/<kind>.

The auth service routes providers here when it runs with OAUTH_MOCK_URL (server side, e.g.
http://host.docker.internal:9912) and OAUTH_MOCK_PUBLIC_URL (browser side, http://127.0.0.1:9912).
Answers in each provider's own response shape and signs id_tokens with an RSA key published at
/<provider>/jwks.
"""
import base64
import hashlib
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import jwt  # PyJWT
from cryptography.hazmat.primitives.asymmetric import rsa

ID_TOKEN_PROVIDERS = ("google", "azure", "apple", "keycloak", "gitlab", "linkedin_oidc", "slack_oidc")


def new_rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


class MockOIDC:
    def __init__(self, port: int = 0, docker_host: str = "host.docker.internal"):
        self.key = new_rsa_key()
        self.kid = uuid.uuid4().hex[:8]
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        self.jwks = {"keys": [{**jwk, "kid": self.kid, "alg": "RS256", "use": "sig"}]}
        self.codes: dict[str, dict] = {}
        self.authorize_requests: list[dict] = []
        self.token_requests: list[dict] = []
        self.people: dict[str, dict] = {}  # the signed-in person per provider (tests may change fields)
        self.docker_host = docker_host
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, obj, code=200):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                parts = u.path.strip("/").split("/")
                if len(parts) != 2:
                    return self._json({"error": "not found"}, 404)
                provider, kind = parts
                if kind == "authorize":
                    code = uuid.uuid4().hex
                    outer.codes[code] = {**q, "provider": provider}
                    outer.authorize_requests.append({**q, "provider": provider})
                    self.send_response(302)
                    self.send_header("location", f"{q['redirect_uri']}?{urlencode({'code': code, 'state': q['state']})}")
                    self.end_headers()
                    return
                if kind == "jwks":
                    return self._json(outer.jwks)
                if not self.headers.get("authorization", "").startswith("Bearer mock-access-"):
                    return self._json({"error": "unauthorized"}, 401)
                if kind == "userinfo":
                    if provider == "twitch" and not self.headers.get("client-id"):
                        return self._json({"error": "missing Client-Id"}, 400)
                    return self._json(outer.userinfo(provider))
                if kind == "emails":
                    p = outer.person(provider)
                    if provider == "bitbucket":
                        return self._json({"values": [{"email": p["email"], "is_primary": True, "is_confirmed": p["verified"]}]})
                    return self._json([{"email": p["email"], "primary": True, "verified": p["verified"]}])
                return self._json({"error": "not found"}, 404)

            def do_POST(self):
                length = int(self.headers.get("content-length", 0))
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
                basic = self.headers.get("authorization", "")
                if basic.startswith("Basic "):
                    cid, _, secret = base64.b64decode(basic[6:]).decode().partition(":")
                    form.setdefault("client_id", cid)
                    form["client_secret"] = secret
                    form["_basic"] = "1"
                outer.token_requests.append(form)
                req = outer.codes.pop(form.get("code", ""), None)
                if not req:
                    return self._json({"error": "invalid_grant"}, 400)
                if req.get("code_challenge"):
                    verifier = form.get("code_verifier", "")
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                    if challenge != req["code_challenge"]:
                        return self._json({"error": "invalid_grant", "error_description": "PKCE mismatch"}, 400)
                elif "code_verifier" in form:
                    return self._json({"error": "invalid_request", "error_description": "unexpected code_verifier"}, 400)
                if form.get("client_secret") != "mock-secret" or form.get("client_id") != req.get("client_id"):
                    return self._json({"error": "invalid_client"}, 401)
                provider = req["provider"]
                tok = {"access_token": "mock-access-" + uuid.uuid4().hex, "token_type": "bearer", "refresh_token": "mock-refresh"}
                if provider in ID_TOKEN_PROVIDERS:
                    tok["id_token"] = outer.id_token(provider, req["client_id"])
                self._json(tok)

        self.server = ThreadingHTTPServer(("0.0.0.0", port), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def person(self, provider: str) -> dict:
        if provider not in self.people:
            u = uuid.uuid4().hex[:8]
            self.people[provider] = {"id": f"{provider}-{u}", "email": f"{provider}-{u}@example.com",
                                     "verified": True, "name": f"{provider.title()} Person"}
        return self.people[provider]

    def issuer(self, provider: str) -> str:
        return f"http://{self.docker_host}:{self.port}/{provider}/issuer"

    def id_token(self, provider: str, aud: str, key=None, kid: str | None = None, **claims) -> str:
        p = self.person(provider)
        now = int(time.time())
        body = {"iss": self.issuer(provider), "sub": p["id"], "aud": aud, "iat": now, "exp": now + 600,
                "email": p["email"], "email_verified": "true" if provider == "apple" else p["verified"], "name": p["name"]}
        if provider == "azure":
            body.pop("email_verified")
            body["xms_edov"] = p["verified"]
        body.update(claims)
        body = {k: v for k, v in body.items() if v is not None}
        return jwt.encode(body, key or self.key, algorithm="RS256", headers={"kid": kid or self.kid})

    def userinfo(self, provider: str) -> dict:
        p = self.person(provider)
        oidc = {"sub": p["id"], "email": p["email"], "email_verified": p["verified"], "name": p["name"], "picture": "https://example.com/p.png"}
        return {
            "slack_oidc": {"ok": True, **oidc},
            "azure": {k: v for k, v in oidc.items() if k != "email_verified"},
            "github": {"id": p["id"], "login": "octo", "name": p["name"], "email": None, "avatar_url": "https://example.com/p.png"},
            "bitbucket": {"uuid": p["id"], "display_name": p["name"], "links": {"avatar": {"href": "https://example.com/p.png"}}},
            "facebook": {"id": p["id"], "name": p["name"], "email": p["email"] if p["verified"] else None,
                         "picture": {"data": {"url": "https://example.com/p.png"}}},
            "discord": {"id": p["id"], "username": "disc", "global_name": p["name"], "email": p["email"], "verified": p["verified"], "avatar": "abc"},
            "x": {"data": {"id": p["id"], "name": p["name"], "username": "xuser", "confirmed_email": p["email"] if p["verified"] else None}},
            "twitter": {"data": {"id": p["id"], "name": p["name"], "username": "xuser", "confirmed_email": p["email"] if p["verified"] else None}},
            "spotify": {"id": p["id"], "display_name": p["name"], "email": p["email"], "images": [{"url": "https://example.com/p.png"}]},
            "twitch": {"data": [{"id": p["id"], "login": "tw", "display_name": p["name"], "email": p["email"],
                                 "profile_image_url": "https://example.com/p.png"}]},
        }.get(provider, oidc)

    def close(self):
        self.server.shutdown()
