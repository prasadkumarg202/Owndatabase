"""Small helpers shared by tests (TOTP, JWT decode, mock OAuth provider)."""
import base64
import hashlib
import hmac
import json
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse


def totp(secret_b32: str, at: float | None = None, step_offset: int = 0) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    counter = int((at or time.time()) // 30) + step_offset
    h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    code = (struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def jwt_claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


class MockOAuth:
    """A tiny OAuth2 provider (GitHub-shaped) for testing the authorization-code + PKCE flow."""

    def __init__(self, port: int = 0):
        self.codes: dict[str, dict] = {}
        self.user = {"id": 424242, "login": "octo", "name": "Octo Cat", "email": None, "avatar_url": "https://example.com/a.png"}
        self.email = f"octo-{uuid.uuid4().hex[:6]}@example.com"
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # silence
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
                if u.path == "/authorize":
                    code = uuid.uuid4().hex
                    outer.codes[code] = q
                    self.send_response(302)
                    self.send_header("location", f"{q['redirect_uri']}?{urlencode({'code': code, 'state': q['state']})}")
                    self.end_headers()
                elif u.path == "/user":
                    self._json(outer.user)
                elif u.path == "/user/emails":
                    self._json([{"email": outer.email, "primary": True, "verified": True}])
                else:
                    self._json({"error": "not found"}, 404)

            def do_POST(self):
                length = int(self.headers.get("content-length", 0))
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
                req = outer.codes.pop(form.get("code", ""), None)
                if not req:
                    return self._json({"error": "invalid_grant"}, 400)
                verifier = form.get("code_verifier", "")
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                if challenge != req.get("code_challenge") or form.get("client_secret") != "mock-secret":
                    return self._json({"error": "invalid_request", "error_description": "PKCE or client secret mismatch"}, 400)
                self._json({"access_token": "mock-access-" + uuid.uuid4().hex, "token_type": "bearer"})

        self.server = HTTPServer(("0.0.0.0", port), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
