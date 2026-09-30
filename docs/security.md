# OwnDatabase — Security Architecture

> **Version:** 0.1.0  
> **Status:** Active

---

## Security Principles

1. **Defense in depth** — multiple independent layers of security
2. **Least privilege** — every component has only the access it needs
3. **Never trust the client** — all authorization enforced server-side
4. **Secrets never in plaintext** — encrypted at rest, never in frontend code
5. **Audit everything** — security events logged, append-only
6. **Open standards** — no homebrew cryptography

---

## Network Security

### Public Internet Boundary

```
Internet → Cloudflare (WAF, DDoS, CDN, TLS) → Caddy (reverse proxy) → Internal services
```

**Cloudflare provides:**
- DDoS mitigation
- WAF rules (OWASP top 10)
- Bot protection
- TLS/HTTPS termination option (or pass-through)
- CDN for static assets

**Caddy provides:**
- Automatic HTTPS (Let's Encrypt / ZeroSSL)
- TLS termination
- Internal routing
- Request size limits
- Rate limiting (basic)

### Port Exposure Policy

| Service | Internal Port | Public? |
|---|---|---|
| Caddy HTTPS | 443 | ✅ Yes |
| Caddy HTTP | 80 | ✅ Yes (redirect only) |
| PostgreSQL | 5432 | ❌ Never |
| PgBouncer | 5433 | ❌ Never |
| Redis | 6379 | ❌ Never |
| Auth API | 3001 | ❌ Via Caddy only |
| REST API | 3002 | ❌ Via Caddy only |
| Realtime | 3003 | ❌ Via Caddy only |
| Storage API | 3004 | ❌ Via Caddy only |
| Control API | 3000 | ❌ Via Caddy only |
| Prometheus | 9090 | ❌ Internal only |
| Grafana | 3005 | ❌ Via Caddy + auth |
| MinIO | 9000 | ❌ Via Storage API |

### Network Isolation

All services communicate on an internal Docker bridge network.  
No service exposes ports to the host except via Caddy.

---

## Authentication Security

### Password Storage

- Algorithm: **Argon2id**
- Parameters: memory=65536 KiB, iterations=3, parallelism=4
- Never store plaintext passwords
- Never store MD5, SHA-1, SHA-256 hashed passwords directly
- Salt is generated per-password by Argon2id

### Session Management

- JWT for stateless API tokens (short-lived, 1 hour default)
- Refresh tokens: long-lived, stored in PostgreSQL, rotated on use
- Sessions stored in `auth.sessions` table
- Secure, HttpOnly, SameSite=Strict cookies for browser
- Refresh token rotation — old token invalidated on refresh
- Session revocation supported per-device

### Token Security

- JWT signed with RS256 (asymmetric key pair)
- Private key stored in secrets, never exposed
- Public key published at `/.well-known/jwks.json`
- Tokens contain: sub, exp, iat, aud, role, project_id
- Token expiry: configurable per project

### Brute Force Protection

- Login attempt rate limiting: 5 attempts per 15 minutes per IP
- Account lockout after 10 failed attempts (temporary)
- CAPTCHA hook for high-risk logins
- OTP expiry: 10 minutes
- OTP attempt limit: 5
- SMS codes: 5 per number per hour, 20 per client IP per hour (SMS pumping)
- SMS webhook provider: HMAC-signed, private / internal targets refused
- CAPTCHA (bot protection), per project in Auth settings: Cloudflare Turnstile or hCaptcha
  required on sign-up, password sign-in, magic link / OTP and password recovery. The client
  sends the widget token as `captcha_token` (or supabase-js's `gotrue_meta_security.captcha_token`;
  SDK: `options.captchaToken`). Verified server-side; if the provider cannot be reached the
  request is refused (fail closed). Refresh-token calls and `service_role` calls are exempt.

### OAuth Security

- PKCE mandatory for all OAuth flows
- State parameter validated
- Nonce validated for OIDC
- Redirect URI strictly validated against allowlist

---

## API Security

### API Keys

Three key types with separate permissions:

| Key Type | Permissions | Exposed to? |
|---|---|---|
| `anon` / publishable | Public data only, respects RLS | Browser / mobile |
| `authenticated` | Per-user data, respects RLS | Authenticated sessions |
| `service_role` | Bypasses RLS, full access | Server-side only |

- `service_role` key must **never** appear in frontend code
- Keys are hashed before storage, shown once on creation
- Keys can be revoked, and rotated with a grace period: `POST /api/keys/:id/rotate {grace_period_seconds}`
  (0 = revoke now) or all of a project's keys at once with `POST /api/keys/rotate` (dashboard: Settings →
  API keys → Rotate; CLI: `odb keys rotate` / `odb keys rotate-all`). A rotated key stops working exactly
  when its grace period ends — cached lookups never outlive a key's expiry.
- Per key (dashboard: Settings → API keys → Limits, or `PATCH /api/keys/:id`):
  - `allowed_ips`: IPs / CIDR ranges (IPv4 and IPv6) allowed to use the key; any other
    address gets 403 from every data-plane service (REST, auth, storage, realtime, functions).
  - `rate_limit_per_minute`: a cap across **all** clients of the key (429 with `Retry-After`,
    `X-RateLimit-Key-Limit` / `-Remaining`), on top of the per-client limits below.
  Both carry over when the key is rotated.

### Rate Limiting

| Endpoint | Limit (defaults) |
|---|---|
| Auth login | account locked after `max_failed_logins` (5) failures for `lockout_minutes` (15), per project |
| Auth signup | 30 / hour / IP |
| Email OTP / magic link | 5 / 15 min / address; 5 guesses per code |
| SMS OTP | 5 / hour / number, 20 / hour / IP |
| REST + RPC, anon | 600 / min per key + client IP (`RATE_LIMIT_ANON`) |
| REST + RPC, signed-in user | 1200 / min per user (`RATE_LIMIT_AUTHENTICATED`) |
| REST + RPC, service_role | 6000 / min per key + client IP (`RATE_LIMIT_SERVICE`) |
| Per API key (optional) | `rate_limit_per_minute` across all clients |
| Per project (optional) | daily quotas — see [limits.md](limits.md) |

### CORS

- Allowed origins configured per project
- Credentials flag respected
- Preflight caching enabled

### CSRF Protection

- SameSite=Strict cookies
- CSRF token required for mutating dashboard operations
- API endpoints authenticated via Authorization header (not cookies) for cross-origin clients

### Input Validation

- All inputs validated with Zod (TypeScript) schemas
- Request size limits enforced at Caddy level
- File type validation at Storage API (MIME + magic bytes)
- SQL injection prevented by parameterized queries exclusively

---

## Database Security

### Role Hierarchy

```
postgres (superuser)
├── platform_admin (control plane only)
│   └── Can create/drop databases, roles
├── service_role (per project)
│   └── Bypasses RLS, full table access
├── authenticated (per project)
│   └── Respects RLS, user-scoped access
├── anon (per project)
│   └── Respects RLS, public data only
├── backup_role (per project)
│   └── Read-only, replication
└── readonly_role (per project)
    └── SELECT only
```

### PostgreSQL Hardening

- `postgres` superuser password is random, never used by applications
- Applications connect as `service_role` or below
- `pg_hba.conf` restricts connections by role and source
- Connection from outside Docker network blocked at OS level
- `search_path` locked per role to prevent schema injection

### Row Level Security

- RLS enabled on all application tables by default
- Policies defined by project/user JWT claims
- `auth.uid()` function returns current user ID from JWT
- `auth.role()` function returns current role
- Service role bypasses RLS for internal operations

### Database Isolation

Each project's data is isolated:

- **Schema isolation** (default): Each project gets its own PostgreSQL schema in a shared database
- **Database isolation** (optional): Each project gets a separate PostgreSQL database

Schema isolation is default for cost efficiency.  
Database isolation is available for compliance requirements.

---

### Project isolation

Each project has its own schema and its own database roles:

| Role | Used for | Reaches |
|---|---|---|
| `<schema>_owner` | SQL editor, migrations (a LOGIN role) | its own schema |
| `<schema>_anon`, `_authn`, `_svc` | REST / RPC / GraphQL / realtime queries (`SET LOCAL ROLE`) | its own schema only; `_svc` bypasses RLS |

- The API roles are members of the shared `anon` / `authenticated` / `service_role`, so policies
  written `TO authenticated` (as in Supabase) apply unchanged.
- The shared roles themselves have no access to any project schema, nor to the `auth.*`, `storage.*`
  or `control_plane.*` tables, which hold every project's data. The services read those over their
  own connections.
- If a project owner grants its schema to a shared role, an event trigger removes that grant
  (`odb_enforce_schema_isolation`).
- Deleting a project drops its roles. Migration 022 converted existing projects;
  `tests/test_tenant_isolation.py` checks these rules.

## Secret Management

### Storage

All project secrets go through the secrets vault ([vault.md](vault.md)):
- envelope encryption: a data key per project, wrapped by master keys that only the control API holds
- each ciphertext is bound to its project and field
- services read secrets through the vault with per-service tokens and policies
- every access is audited
- secrets are never returned by the API; function secrets are write-only

### Secret Categories

| Category | Examples |
|---|---|
| Database credentials | Connection strings, passwords |
| API keys | Third-party service keys |
| OAuth secrets | Client secrets |
| Signing keys | JWT private keys |
| Storage credentials | S3 access keys |
| Function secrets | Passed per invocation as `req.env` (not process env), to the isolated functions runtime — see [functions.md](functions.md) |

### Secret Rotation

- Master keys: add a new key first in `VAULT_MASTER_KEYS` and restart control-api; the data keys are re-wrapped
- Project data keys: `POST /api/projects/:id/vault/rotate` re-encrypts the project's secrets
- Services drop cached secrets as soon as a project changes (and after 60 s at the latest)

---

## Backup Security

- Backups encrypted with pgBackRest encryption (AES-256-CBC)
- Backup encryption key stored separately from database
- Backup storage credentials scoped to write-only access
- Backup deletion requires admin MFA confirmation
- Backup verification: periodic automated restore tests
- Immutable backup support where storage provider allows (Object Lock)

---

## Audit Logging

### Events Recorded

| Category | Events |
|---|---|
| Auth | login, logout, failed_login, password_change, mfa_enabled, mfa_disabled |
| API keys | key_created, key_deleted, key_rotated |
| Secrets | secret_created, secret_deleted, secret_rotated |
| Database | db_created, db_deleted, migration_applied, extension_enabled |
| Users | user_created, user_deleted, role_changed |
| Backups | backup_created, backup_deleted, restore_performed |
| Deployments | deployment_started, deployment_succeeded, deployment_failed, rollback |
| Admin | admin_login, admin_logout, settings_changed |

### Audit Log Properties

```typescript
interface AuditLog {
  id: uuid;
  timestamp: timestamptz;
  event_type: string;
  actor_id: uuid;          // who performed the action
  actor_type: 'user' | 'api_key' | 'system';
  target_type: string;     // what was affected
  target_id: string;
  project_id: uuid | null;
  ip_address: string;
  user_agent: string;
  metadata: jsonb;         // event-specific details
  // append-only — no UPDATE or DELETE
}
```

Audit logs are **append-only** — no application user may update or delete them.  
Retention: minimum 1 year for security events.

---

## Dashboard Security

- Admin MFA enforced (TOTP)
- Session timeout: configurable (default 2 hours)
- Device management: active sessions visible, revocable
- IP restriction: optional per-organization
- Destructive actions require confirmation dialog
- Production environment changes logged and alerted

---

## Vulnerability Disclosure

This platform is self-hosted — operators are responsible for:

- OS patching
- Docker image updates
- PostgreSQL version upgrades
- Dependency updates

The platform will include:

- Automated dependency scanning in CI
- Security advisory subscription mechanism
- Upgrade notification in dashboard
