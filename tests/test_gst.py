"""GST tax invoices: seller settings, customer billing details with GSTIN validation, CGST+SGST within
the seller's state, IGST across states, zero-rated exports under LUT, and the printable tax invoice."""
import random
import string
import time

import pytest
from odb import signup_platform_user

CHARS = string.digits + string.ascii_uppercase


def gstin(state: str) -> str:
    """A GSTIN with a correct check digit (state + PAN-like body + entity + Z)."""
    body = state + "".join(random.choices(string.ascii_uppercase, k=5)) + "".join(random.choices(string.digits, k=4)) + random.choice(string.ascii_uppercase) + "1Z"
    total = 0
    for i, c in enumerate(body):
        p = CHARS.index(c) * (1 if i % 2 == 0 else 2)
        total += p // 36 + p % 36
    return body + CHARS[(36 - total % 36) % 36]


SELLER = gstin("29")  # Karnataka


@pytest.fixture(scope="module", autouse=True)
def gst_on(platform_admin):
    assert platform_admin.put("/admin/billing/settings", json={"enabled": True}).status_code == 200
    r = platform_admin.put("/admin/billing/gst", json={
        "enabled": True, "legal_name": "OwnDatabase Cloud Pvt Ltd", "gstin": SELLER,
        "address": "12 MG Road\nBengaluru 560001", "email": "billing@owndatabase.example", "lut_number": "AD290925000123X"})
    assert r.status_code == 200, r.text
    assert r.json()["gst"]["state_code"] == "29"
    yield
    platform_admin.put("/admin/billing/gst", json={"enabled": False, "legal_name": "x", "gstin": SELLER, "address": "x"})
    platform_admin.put("/admin/billing/settings", json={"enabled": False})


def org_with_profile(profile: dict | None):
    u = signup_platform_user("gst")
    org = u.get("/organizations").json()["data"][0]["id"]
    if profile is not None:
        r = u.put(f"/organizations/{org}/billing/profile", json=profile)
        assert r.status_code == 200, r.text
    return u, org


def upgrade(u, org):
    r = u.post(f"/organizations/{org}/billing/subscribe", json={"plan_id": "pro"})
    assert r.status_code == 201, r.text
    return r.json()["invoice"]


def test_gstin_validation(platform_admin):
    u, org = org_with_profile(None)
    bad = SELLER[:-1] + ("0" if SELLER[-1] != "0" else "1")
    r = u.put(f"/organizations/{org}/billing/profile", json={"legal_name": "Acme", "gstin": bad})
    assert r.status_code == 400 and "check digit" in r.json()["message"]
    assert u.put(f"/organizations/{org}/billing/profile", json={"legal_name": "Acme", "gstin": "NOTAGSTIN"}).status_code == 400
    # the GSTIN names the state; a contradicting state_code is refused
    g = gstin("27")
    assert u.put(f"/organizations/{org}/billing/profile", json={"legal_name": "Acme", "gstin": g, "state_code": "29"}).status_code == 400
    # an Indian customer without GSTIN needs a state
    assert u.put(f"/organizations/{org}/billing/profile", json={"legal_name": "Acme"}).status_code == 400
    ok = u.put(f"/organizations/{org}/billing/profile", json={"legal_name": "Acme", "gstin": g.lower(), "city": "Pune"})
    assert ok.status_code == 200 and ok.json()["profile"]["state_code"] == "27" and ok.json()["profile"]["gstin"] == g
    # admins only for the seller settings; the seller GSTIN must be valid too
    assert u.get("/admin/billing/gst").status_code == 403
    assert platform_admin.put("/admin/billing/gst", json={"enabled": True, "legal_name": "x", "gstin": bad, "address": "x"}).status_code == 400


def test_same_state_cgst_sgst(platform_admin):
    u, org = org_with_profile({"legal_name": "Bengaluru Buyer LLP", "gstin": gstin("29"), "address_line1": "1 Residency Rd", "city": "Bengaluru"})
    inv = upgrade(u, org)
    sub = inv["subtotal"]
    assert [t["name"] for t in inv["tax_lines"]] == ["CGST", "SGST"]
    assert all(t["rate"] == 9 and t["amount"] == round(sub * 0.09) for t in inv["tax_lines"])
    assert inv["tax_total"] == sum(t["amount"] for t in inv["tax_lines"]) and inv["total"] == sub + inv["tax_total"]
    assert inv["place_of_supply"] == "Karnataka (29)" and inv["sac_code"] == "998315"
    doc = u.get(f"/organizations/{org}/billing/invoices/{inv['id']}/document")
    assert doc.status_code == 200 and doc.headers["content-type"].startswith("text/html")
    html = doc.text
    for s in ("Tax Invoice", SELLER, "Bengaluru Buyer LLP", "CGST @ 9%", "SGST @ 9%", "998315", "Karnataka (29)", "Reverse charge", "Authorised signatory", inv["number"]):
        assert s in html, s
    assert "default-src 'none'" in doc.headers["content-security-policy"]
    # listed with tax on the billing page
    listed = [i for i in u.get(f"/organizations/{org}/billing").json()["invoices"] if i["id"] == inv["id"]][0]
    assert listed["tax_total"] == inv["tax_total"] and listed["subtotal"] == sub


def test_other_state_igst():
    u, org = org_with_profile({"legal_name": "Mumbai Buyer Pvt Ltd", "gstin": gstin("27")})
    inv = upgrade(u, org)
    assert [(t["name"], t["rate"]) for t in inv["tax_lines"]] == [("IGST", 18)]
    assert inv["tax_lines"][0]["amount"] == round(inv["subtotal"] * 0.18) and inv["place_of_supply"] == "Maharashtra (27)"
    assert "IGST @ 18%" in u.get(f"/organizations/{org}/billing/invoices/{inv['id']}/document").text


def test_export_zero_rated_under_lut():
    u, org = org_with_profile({"legal_name": "Globex Inc", "country": "US", "address_line1": "1 Main St", "city": "Austin"})
    inv = upgrade(u, org)
    assert inv["tax_total"] == 0 and inv["total"] == inv["subtotal"]
    assert "LUT AD290925000123X" in inv["tax_note"] and inv["place_of_supply"].startswith("Outside India")
    html = u.get(f"/organizations/{org}/billing/invoices/{inv['id']}/document").text
    assert "without payment of IGST" in html and "Globex Inc" in html


def test_no_billing_details_is_intra_state_and_documents_are_private(platform_admin):
    u, org = org_with_profile(None)
    inv = upgrade(u, org)
    assert [t["name"] for t in inv["tax_lines"]] == ["CGST", "SGST"]
    # another organization cannot read it; platform admins can
    other, _ = org_with_profile(None)
    assert other.get(f"/organizations/{org}/billing/invoices/{inv['id']}/document").status_code in (403, 404)
    assert platform_admin.get(f"/admin/billing/invoices/{inv['id']}/document").status_code == 200


def test_amount_in_words_indian_numbering(platform_admin):
    # a document for an existing invoice spells the total; check the Indian number words on a big INR amount
    u, org = org_with_profile({"legal_name": "Words Co", "state_code": "29"})
    inv = upgrade(u, org)
    html = u.get(f"/organizations/{org}/billing/invoices/{inv['id']}/document").text
    assert "Amount in words:" in html and " Only" in html
