"""Organization invitations: invite by email, accept / decline / revoke, role rules."""
import uuid

import pytest
from odb import signup_platform_user


def new_email(prefix="inv") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}@test.owndatabase.dev"


@pytest.fixture()
def org(owner):
    slug = "org-" + uuid.uuid4().hex[:8]
    r = owner.post("/organizations", json={"name": "Invite Co", "slug": slug})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def invite(owner, org, email, role="developer"):
    r = owner.post(f"/organizations/{org}/invitations", json={"email": email, "role": role})
    assert r.status_code == 201, r.text
    body = r.json()
    return body, body["invite_url"].rsplit("/", 1)[-1]


def test_invite_someone_without_an_account(owner, org):
    email = new_email()
    body, token = invite(owner, org, email.upper(), "viewer")  # stored lower-case
    assert body["email"] == email and body["invite_url"].endswith(f"/invite/{token}")
    pending = owner.get(f"/organizations/{org}/invitations").json()["data"]
    assert [i["email"] for i in pending] == [email]

    newcomer = signup_platform_user(email=email, password="Pw-newcomer-1")
    info = newcomer.get(f"/invitations/{token}").json()
    assert info["status"] == "pending" and info["email_matches"] is True
    assert info["organization_name"] == "Invite Co" and info["role"] == "viewer"

    r = newcomer.post(f"/invitations/{token}/accept")
    assert r.status_code == 200, r.text
    members = {m["email"]: m["role"] for m in owner.get(f"/organizations/{org}").json()["members"]}
    assert members[email] == "viewer"
    assert org in [o["id"] for o in newcomer.get("/organizations").json()["data"]]

    assert newcomer.post(f"/invitations/{token}/accept").status_code == 410   # single use
    assert owner.get(f"/organizations/{org}/invitations").json()["data"] == []
    # already a member now
    assert owner.post(f"/organizations/{org}/invitations", json={"email": email}).status_code == 409


def test_only_the_invited_address_can_accept(owner, org):
    email = new_email()
    _, token = invite(owner, org, email)
    stranger = signup_platform_user("stranger")
    assert stranger.get(f"/invitations/{token}").json()["email_matches"] is False
    assert stranger.post(f"/invitations/{token}/accept").status_code == 403
    assert stranger.post(f"/invitations/{token}/decline").status_code == 403
    assert stranger.get(f"/invitations/{'x' * 43}").status_code == 404


def test_revoke_and_reinvite(owner, org):
    email = new_email()
    first, old_token = invite(owner, org, email)
    _, token = invite(owner, org, email, "admin")      # replaces the open one
    person = signup_platform_user(email=email, password="Pw-person-123")
    assert person.post(f"/invitations/{old_token}/accept").status_code == 410
    assert owner.delete(f"/organizations/{org}/invitations/{first['id']}").status_code == 404  # already replaced

    pending = owner.get(f"/organizations/{org}/invitations").json()["data"]
    assert owner.delete(f"/organizations/{org}/invitations/{pending[0]['id']}").status_code == 200
    assert person.get(f"/invitations/{token}").json()["status"] == "revoked"
    assert person.post(f"/invitations/{token}/accept").status_code == 410


def test_decline(owner, org):
    email = new_email()
    _, token = invite(owner, org, email)
    person = signup_platform_user(email=email, password="Pw-person-123")
    assert person.post(f"/invitations/{token}/decline").status_code == 200
    assert person.post(f"/invitations/{token}/accept").status_code == 410
    assert owner.get(f"/organizations/{org}/invitations").json()["data"] == []


def test_role_rules(owner, org):
    admin_email, dev_email = new_email("admin"), new_email("dev")
    for email, role in [(admin_email, "admin"), (dev_email, "developer")]:
        _, token = invite(owner, org, email, role)
        assert signup_platform_user(email=email, password="Pw-member-123").post(f"/invitations/{token}/accept").status_code == 200
    admin = signup_platform_user(email=admin_email, password="Pw-member-123")
    dev = signup_platform_user(email=dev_email, password="Pw-member-123")

    assert dev.post(f"/organizations/{org}/invitations", json={"email": new_email()}).status_code == 403
    assert dev.get(f"/organizations/{org}/invitations").status_code == 403
    assert admin.post(f"/organizations/{org}/invitations", json={"email": new_email(), "role": "owner"}).status_code == 403
    assert admin.post(f"/organizations/{org}/invitations", json={"email": new_email(), "role": "developer"}).status_code == 201
    # other organizations' invitations are invisible
    outsider = signup_platform_user("outsider")
    assert outsider.get(f"/organizations/{org}/invitations").status_code == 404
