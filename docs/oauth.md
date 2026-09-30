# OAuth sign-in

Supported providers (use these names with `supabase.auth.signInWithOAuth({ provider })`
or `GET <auth url>/authorize?provider=<name>`):

| Provider | Name | Notes |
|---|---|---|
| Google | `google` | also native sign-in with an ID token |
| Apple | `apple` | Services ID + `.p8` key (Team ID, Key ID) or a ready client-secret JWT; also native sign-in |
| Microsoft | `azure` | optional tenant URL `https://login.microsoftonline.com/<tenant>`; email counts as verified only with `xms_edov` |
| GitHub | `github` | optional GitHub Enterprise URL |
| GitLab | `gitlab` | optional self-hosted URL |
| Facebook | `facebook` | also Limited Login ID tokens |
| Bitbucket, Discord, Twitch, Spotify | `bitbucket`, `discord`, `twitch`, `spotify` | Spotify emails are treated as unverified |
| LinkedIn, Slack | `linkedin_oidc`, `slack_oidc` | OpenID Connect |
| X / Twitter | `x` (alias `twitter`) | OAuth 2.0; email only with the `users.email` scope |
| Keycloak / any OIDC server with Keycloak's paths | `keycloak` | realm URL required |

## Setup

1. Dashboard → Authentication → Settings → **OAuth providers**: enable the
   provider, paste the client ID and secret.
2. Register the callback URL shown there with the provider:
   `<auth url>/callback` (for example `https://db.example.com/auth/v1/<projectId>/callback`).
3. Add your app's URLs to **Site URL / redirect URLs**; `redirect_to` must match one.

Platform-wide defaults can come from `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`
environment variables on the auth service (docker-compose passes Google and GitHub).

## Flows

- **Implicit** (supabase-js default): tokens come back in the redirect's
  `#access_token=…&refresh_token=…&provider_token=…`.
- **PKCE** (`flowType: 'pkce'`, `@supabase/ssr`): the redirect carries `?code=`;
  `exchangeCodeForSession(code)` calls `POST /token?grant_type=pkce`.
- **Native ID token** (`signInWithIdToken({ provider, token, nonce })`, Flutter /
  React Native / iOS / Android): Google, Apple, Microsoft, Facebook and Keycloak.
  The token's signature is checked against the provider's JWKS, its audience
  against the client ID plus **Other client IDs** (your iOS / Android client IDs),
  and its nonce against `sha256(nonce)`.

`scopes` add to the provider's default scopes.

## Accounts

A provider identity signs in the user it was linked to. Otherwise a *verified*
provider email is matched to an existing user; if that user never confirmed
their address, their password and sessions are removed before linking (so a
pre-registered account can't be taken over). An unverified provider email that
already belongs to a user is refused.

## Testing

`tests/test_oauth_providers.py` runs every provider against `tests/mock_oidc.py`.
It needs `OAUTH_MOCK_URL` / `OAUTH_MOCK_PUBLIC_URL` set for the auth service.
These settings are for tests only: while they are set, providers never reach
the real Google, Apple and so on.
