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
- Keys can be rotated, revoked, scoped to IP ranges

### Rate Limiting

| Endpoint | Limit |
|---|---|
| Auth login | 5 req / 15 min / IP |
| Auth signup | 10 req / hour / IP |
| OTP | 5 attempts / 10 min |
| API (anon) | 100 req / min / key |
| API (authenticated) | 500 req / min / key |
| API (service_role) | 2000 req / min / key |
| Storage upload | 10 req / min / user |

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

## Secret Management

### Storage

- Secrets stored in `control_plane.secrets` table
- Encrypted with AES-256-GCM using a master key
- Master key stored in environment variable, never in database
- Secrets never logged or returned in API responses after creation
- Only secret metadata (name, created_at, last_rotated) is shown after creation

### Secret Categories

| Category | Examples |
|---|---|
| Database credentials | Connection strings, passwords |
| API keys | Third-party service keys |
| OAuth secrets | Client secrets |
| Signing keys | JWT private keys |
| Storage credentials | S3 access keys |
| Function secrets | Per-function environment |

### Secret Rotation

- Rotation creates a new version, old version retained for grace period
- Grace period: configurable, default 24 hours
- Services must reload secrets on rotation signal

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
