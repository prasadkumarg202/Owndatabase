# Custom domains

Serve a project's APIs from your own hostname — `https://api.example.com` —
with the same paths as Supabase (no project id in the URL):

| On the custom domain | Same as |
|---|---|
| `https://api.example.com/rest/v1/orders` | `/rest/v1/<projectId>/orders` |
| `https://api.example.com/auth/v1/token?grant_type=password` | `/auth/v1/<projectId>/token…` |
| `https://api.example.com/storage/v1/object/public/…` | `/storage/v1/<projectId>/object/public/…` |
| `https://api.example.com/functions/v1/hello` | `/functions/v1/<projectId>/hello` |
| `wss://api.example.com/realtime?apikey=…` | `/realtime?project_id=<projectId>&apikey=…` |

So `createClient('https://api.example.com', anonKey)` from supabase-js works
for the database, auth, storage, functions and realtime (docs/supabase-js.md;
without a custom domain use `https://<platform>/p/<projectId>`). Paths that
include a project id keep working, and API
keys still decide access (another project's key is refused on your domain).

## Setup

1. Project → Settings → General → **Custom domains** → add `api.example.com`
   (owners / admins; up to 5 per project), or `POST /api/projects/:id/domains`.
2. Create the DNS records it shows:
   - `TXT _odb-challenge.api.example.com` = the verification token
   - `CNAME api.example.com` → the platform host (or an `A` record to its IP)
3. Click **Verify** (`POST …/domains/:domainId/verify`). Once the TXT record
   resolves, the domain is `verified` and every service routes it within a
   second.
4. The first HTTPS request makes Caddy obtain a Let's Encrypt certificate
   (on-demand TLS). Ports 80 and 443 must reach the platform.

## Security

- Caddy only requests certificates for hostnames the control API reports as
  verified (`on_demand_tls { ask …/api/internal/domains/check }`), so nobody can
  make the platform request certificates for arbitrary domains.
- A hostname can belong to one project only, and must not be the platform's
  own hostname.
- Platform admins can mark a domain verified without DNS
  (`POST …/force-verify`) for support and testing.

Removing a domain stops routing it immediately; its certificate is simply not
renewed.
