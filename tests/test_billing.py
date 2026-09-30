"""Billing: plans, project caps and limits, upgrades via invoices, Stripe/Razorpay webhooks, usage invoices.

Billing is switched on only for this module (a runtime platform setting) and off again afterwards.
Webhook tests sign fake events with STRIPE_WEBHOOK_SECRET / RAZORPAY_WEBHOOK_SECRET from the stack's .env.
"""
import hashlib
import hmac
import json
import os
import time
import uuid
from pathlib import Path

import pytest
import requests
from odb import URLS, create_project, signup_platform_user


def env_secret(name):
    if os.environ.get(name):
        return os.environ[name]
    env = Path(__file__).resolve().parents[1] / ".env"
    for line in env.read_text(encoding="utf-8").splitlines() if env.exists() else []:
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip()
    return None


@pytest.fixture(scope="module", autouse=True)
def billing_on(platform_admin):
    assert platform_admin.put("/admin/billing/settings", json={"enabled": True}).status_code == 200
    time.sleep(0.2)
    yield
    platform_admin.put("/admin/billing/settings", json={"enabled": False})


def new_org_owner(prefix="bill"):
    u = signup_platform_user(prefix)
    org = u.get("/organizations").json()["data"][0]["id"]
    return u, org


def webhook(provider, payload, secret, headers=None):
    raw = json.dumps(payload)
    if provider == "stripe":
        t = str(int(time.time()))
        sig = hmac.new(secret.encode(), f"{t}.{raw}".encode(), hashlib.sha256).hexdigest()
        h = {"stripe-signature": f"t={t},v1={sig}"}
    else:
        h = {"x-razorpay-signature": hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest(), "x-razorpay-event-id": payload.get("id", uuid.uuid4().hex)}
    return requests.post(f"{URLS['api']}/api/billing/webhooks/{provider}", data=raw, headers={"content-type": "application/json", **h, **(headers or {})}, timeout=15)


def test_plans_and_free_plan_caps(platform_admin):
    plans = {p["id"]: p for p in platform_admin.get("/billing/plans").json()["data"]}
    assert {"free", "pro", "team"} <= set(plans) and plans["pro"]["price_monthly"] == 2500

    u, org = new_org_owner()
    b = u.get(f"/organizations/{org}/billing").json()
    assert b["subscription"]["plan_id"] == "free" and b["subscription"]["status"] == "active"

    p1 = create_project(u, "Free one")
    create_project(u, "Free two")
    r = u.post("/projects", json={"name": "Free three", "organization_id": org})
    assert r.status_code == 402 and "Free plan allows 2" in r.json()["message"], r.text
    # the plan's limits are applied to new projects
    assert u.get(f"/projects/{p1.id}/limits").json()["limits"]["api_requests_per_day"] == 50000
    # branches do not count against the cap
    assert u.post(f"/projects/{p1.id}/branches", json={"name": "dev"}).status_code == 201
    # clients cannot fake the internal branch marker
    r = u.post("/projects", json={"name": "Sneaky", "organization_id": org}, headers={"x-odb-branch": "1"})
    assert r.status_code == 402


def test_upgrade_is_applied_when_paid(platform_admin):
    u, org = new_org_owner()
    p1 = create_project(u, "Up one")
    create_project(u, "Up two")
    r = u.post(f"/organizations/{org}/billing/subscribe", json={"plan_id": "pro"})
    assert r.status_code == 201 and r.json()["status"] == "payment_required", r.text
    inv = r.json()["invoice"]
    assert inv["total"] == 2500 and inv["status"] == "open" and inv["lines"][0]["description"] == "Pro plan"
    b = u.get(f"/organizations/{org}/billing").json()
    assert b["subscription"]["plan_id"] == "free" and b["subscription"]["pending_plan_id"] == "pro"
    assert u.post("/projects", json={"name": "Up three", "organization_id": org}).status_code == 402

    # hand-set limits survive plan changes
    assert platform_admin.put(f"/projects/{p1.id}/limits", json={"auth_users": 7}).status_code == 200
    assert u.post(f"/admin/billing/invoices/{inv['id']}/mark-paid").status_code == 403       # admins only
    assert platform_admin.post(f"/admin/billing/invoices/{inv['id']}/mark-paid").status_code == 200
    b = u.get(f"/organizations/{org}/billing").json()
    assert b["subscription"]["plan_id"] == "pro" and b["subscription"]["pending_plan_id"] is None
    assert u.post("/projects", json={"name": "Up three", "organization_id": org}).status_code == 201
    assert u.get(f"/projects/{p1.id}/limits").json()["limits"]["auth_users"] == 7
    assert platform_admin.post(f"/admin/billing/invoices/{inv['id']}/mark-paid").status_code == 409   # already paid

    # cancel: back to Free at the end of the period
    r = u.post(f"/organizations/{org}/billing/cancel")
    assert r.status_code == 200 and r.json()["status"] == "scheduled"
    assert u.get(f"/organizations/{org}/billing").json()["subscription"]["cancel_at_period_end"] is True


@pytest.mark.parametrize("provider", ["stripe", "razorpay"])
def test_payment_webhooks(provider):
    secret = env_secret("STRIPE_WEBHOOK_SECRET" if provider == "stripe" else "RAZORPAY_WEBHOOK_SECRET")
    if not secret:
        pytest.skip(f"{provider} webhook secret not configured on the stack")
    u, org = new_org_owner(provider)
    inv = u.post(f"/organizations/{org}/billing/subscribe", json={"plan_id": "team"}).json()["invoice"]
    if provider == "stripe":
        event = {"id": f"evt_{uuid.uuid4().hex}", "type": "checkout.session.completed",
                 "data": {"object": {"id": "cs_test_1", "payment_status": "paid", "metadata": {"invoice_id": inv["id"]}}}}
    else:
        event = {"id": f"evt_{uuid.uuid4().hex}", "event": "payment_link.paid",
                 "payload": {"payment_link": {"entity": {"id": "plink_1", "notes": {"invoice_id": inv["id"]}}}}}
    assert webhook(provider, event, "wrong-secret").status_code == 400                 # forged
    r = webhook(provider, event, secret)
    assert r.status_code == 200 and r.json() == {"received": True}, r.text
    assert webhook(provider, event, secret).json().get("duplicate") is True            # retried delivery
    b = u.get(f"/organizations/{org}/billing").json()
    assert b["subscription"]["plan_id"] == "team"
    assert next(i for i in b["invoices"] if i["id"] == inv["id"])["status"] == "paid"


def test_usage_snapshot_and_period_invoice(platform_admin):
    u, org = new_org_owner("usage")
    p = create_project(u, "Metered")
    p.sql("create table m (id int primary key); grant select on m to anon")
    for _ in range(5):
        p.rest("GET", "m")
    platform_admin.put(f"/admin/billing/organizations/{org}/plan", json={"plan_id": "pro"})
    assert platform_admin.post("/admin/billing/usage/snapshot").status_code == 200
    b = u.get(f"/organizations/{org}/billing").json()
    assert b["plan"]["id"] == "pro" and b["usage"]["api_requests"] >= 5 and b["included"]["api_requests"] == 5000000
    assert [l["description"] for l in b["estimated_lines"]] == ["Pro plan"]              # nothing over the included amounts

    period = time.strftime("%Y-%m", time.gmtime())
    first = platform_admin.post("/admin/billing/invoices/generate", json={"period": period}).json()["created"]
    again = platform_admin.post("/admin/billing/invoices/generate", json={"period": period}).json()["created"]
    mine = [i for i in u.get(f"/organizations/{org}/billing").json()["invoices"] if i["kind"] == "period"]
    assert len(mine) == 1 and mine[0]["id"] in first and mine[0]["id"] not in again and mine[0]["total"] == 2500
    assert platform_admin.post(f"/admin/billing/invoices/{mine[0]['id']}/void").status_code == 200


def test_billing_off_means_no_enforcement(platform_admin):
    u, org = new_org_owner("off")
    platform_admin.put("/admin/billing/settings", json={"enabled": False})
    try:
        time.sleep(5.5)   # the switch is cached for up to 5 s per control API process
        for i in range(3):
            assert u.post("/projects", json={"name": f"Unbilled {i}", "organization_id": org}).status_code == 201
        assert u.get(f"/organizations/{org}/billing").status_code == 404
        assert webhook("stripe", {"id": "x", "type": "noop"}, "s").status_code == 404
    finally:
        platform_admin.put("/admin/billing/settings", json={"enabled": True})
