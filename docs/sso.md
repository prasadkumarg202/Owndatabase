# Single sign-on (SAML 2.0)

Let a company's users sign in with their own identity provider: Okta, Microsoft Entra ID (Azure AD),
Google Workspace, OneLogin, JumpCloud, Keycloak, and others. This works like Supabase's
`signInWithSSO()`.

## Register an identity provider

1. In the IdP, create a SAML app with these values:
   - **Entity ID / Audience:** `<auth url>/sso/saml/metadata`, for example
     `https://db.example.com/auth/v1/<projectId>/sso/saml/metadata`. That URL also serves our SP
     metadata, which many IdPs can import directly.
   - **ACS / Reply URL:** `<auth url>/sso/saml/acs` (HTTP-POST).
   - **NameID:** the user's email (or a persistent id, with an `email` attribute).
   - **Signing:** sign the assertion (RSA-SHA256).
2. Register the IdP with the project's **service_role** key (Supabase's admin API):

```bash
curl -X POST "$AUTH_URL/admin/sso/providers" -H "apikey: $SERVICE_KEY" -H 'content-type: application/json' -d '{
  "type": "saml",
  "metadata_url": "https://idp.example.com/app/xyz/sso/saml/metadata",
  "domains": ["acme.com"],
  "attribute_mapping": { "keys": { "name": { "name": "displayName" }, "department": { "name": "department" } } }
}'
```

- **Metadata:** pass `metadata_xml` instead of `metadata_url` to paste the IdP metadata. Metadata URLs
  must be public `https://` addresses.
- **Other operations:** `GET` lists providers, `GET|PUT|DELETE /admin/sso/providers/<id>` manages one.
  An update with new metadata must keep the same entity id, which lets you rotate certificates.
- **Domains:** each domain belongs to one provider.

## Sign in

```js
const { data } = await supabase.auth.signInWithSSO({ domain: 'acme.com', options: { redirectTo: 'https://app.acme.com/welcome' } });
// or { providerId: '<id>' }. The browser goes to the IdP and comes back to redirectTo signed in.
```

`POST <auth url>/sso` with `{ domain | provider_id, redirect_to, skip_http_redirect }` returns the IdP URL.
With `flowType: 'pkce'`, the app gets `?code=` back and supabase-js exchanges it.

## What is checked

Responses are validated with `@node-saml/node-saml`:
- **Signature:** the assertion must be signed with one of the IdP's certificates (from its metadata).
- **Addressing:** the issuer must be the IdP's entity id, and the audience must be this project.
- **Timing:** the assertion must be within its validity window (60 s clock skew allowed).
- **Our own request:** the response must answer an AuthnRequest this project sent, via
  `InResponseTo`. That request id is also bound to the `RelayState`.
- **Single use:** each response is accepted at most once; unanswered requests expire after 10 minutes.

**Emails:** an IdP is only trusted for its registered domains. An assertion for an address in
another domain is refused. An address in its domains is treated as verified, so it can sign in to an
existing account with that email. SSO users are recorded with the identity provider `sso:<provider id>`,
and mapped attributes are stored on the identity.

`tests/test_sso_saml.py` runs the whole flow against a test IdP (`tests/mock_saml_idp.py`), including
forged, tampered, replayed, wrong-audience and wrong-domain responses.
