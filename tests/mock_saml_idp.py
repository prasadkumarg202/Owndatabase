"""A SAML 2.0 identity provider for tests: IdP metadata, and signed SAML responses answering the
AuthnRequest in a sign-in URL (HTTP-Redirect binding)."""
import base64
import datetime as dt
import uuid
import zlib
from urllib.parse import parse_qs, urlparse

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from lxml import etree
from signxml import XMLSigner, methods

SAML = "urn:oasis:names:tc:SAML:2.0:assertion"
SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol"


def new_keypair(cn="mock-idp"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=365)).sign(key, hashes.SHA256()))
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return key_pem, cert.public_bytes(serialization.Encoding.PEM)


def ts(delta_seconds=0):
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=delta_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


class MockIdP:
    def __init__(self, entity_id=None):
        self.entity_id = entity_id or f"https://idp-{uuid.uuid4().hex[:6]}.example.test/saml"
        self.sso_url = "https://idp.example.test/sso"
        self.key, self.cert = new_keypair()

    def metadata(self) -> str:
        cert_b64 = "".join(self.cert.decode().strip().splitlines()[1:-1])
        return f"""<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="{self.entity_id}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>{cert_b64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="{self.sso_url}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>"""

    @staticmethod
    def read_request(sign_in_url: str) -> dict:
        """What the SP asked for: request id, ACS URL, audience (issuer) and the RelayState."""
        q = parse_qs(urlparse(sign_in_url).query)
        req = etree.fromstring(zlib.decompress(base64.b64decode(q["SAMLRequest"][0]), -15))
        issuer = req.find(f"{{{SAML}}}Issuer").text
        return {"id": req.get("ID"), "acs": req.get("AssertionConsumerServiceURL"), "sp": issuer, "relay": q["RelayState"][0]}

    def response(self, req: dict, email: str, name="Alice Example", audience=None, in_response_to=None,
                 key=None, cert=None, tamper=None, issuer=None) -> str:
        """A SAMLResponse (base64) with a signed assertion. `tamper` edits the XML after signing."""
        irt = in_response_to or req["id"]
        aid = f"_a{uuid.uuid4().hex}"
        assertion = f"""<saml:Assertion xmlns:saml="{SAML}" ID="{aid}" Version="2.0" IssueInstant="{ts()}">
<saml:Issuer>{issuer or self.entity_id}</saml:Issuer>
<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">{email}</saml:NameID>
<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="{irt}" NotOnOrAfter="{ts(300)}" Recipient="{req['acs']}"/></saml:SubjectConfirmation></saml:Subject>
<saml:Conditions NotBefore="{ts(-60)}" NotOnOrAfter="{ts(300)}"><saml:AudienceRestriction><saml:Audience>{audience or req['sp']}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
<saml:AuthnStatement AuthnInstant="{ts()}" SessionIndex="_s{uuid.uuid4().hex}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
<saml:AttributeStatement>
<saml:Attribute Name="email"><saml:AttributeValue>{email}</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="displayName"><saml:AttributeValue>{name}</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="department"><saml:AttributeValue>Engineering</saml:AttributeValue></saml:Attribute>
</saml:AttributeStatement>
</saml:Assertion>"""
        signed = XMLSigner(method=methods.enveloped, signature_algorithm="rsa-sha256", digest_algorithm="sha256",
                           c14n_algorithm="http://www.w3.org/2001/10/xml-exc-c14n#").sign(
            etree.fromstring(assertion), key=key or self.key, cert=cert or self.cert, reference_uri=aid)
        # schema order: the Signature goes right after the Issuer (the enveloped transform ignores where it is)
        sig = signed.find("{http://www.w3.org/2000/09/xmldsig#}Signature")
        signed.remove(sig)
        signed.insert(1, sig)
        body = etree.tostring(signed).decode()
        doc = f"""<samlp:Response xmlns:samlp="{SAMLP}" xmlns:saml="{SAML}" ID="_r{uuid.uuid4().hex}" Version="2.0" IssueInstant="{ts()}" Destination="{req['acs']}" InResponseTo="{irt}">
<saml:Issuer>{issuer or self.entity_id}</saml:Issuer>
<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
{body}
</samlp:Response>"""
        if tamper:
            doc = tamper(doc)
        return base64.b64encode(doc.encode()).decode()
