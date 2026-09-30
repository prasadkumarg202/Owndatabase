# Secrets vault

Every credential OwnDatabase stores for a project is kept by the vault:

- OAuth client secrets (and Apple `.p8` keys)
- the project's Twilio auth token and SMS-webhook signing secret
- CAPTCHA secrets
- function secrets
- database-webhook signing secrets
- the project's database owner password

```
VAULT_MASTER_KEYS (control API only)
  └ data key per project        control_plane.vault_keys, stored wrapped by a master key
      └ secret                  "vault:v1:<data key id>:<AES-256-GCM iv|tag|ciphertext>"
                                AAD = project + field name
```

- **Encrypted at rest, with envelope encryption.** AES-256-GCM. Only the control API holds a
  master key. A database dump, backup or replica is useless without it.
- **Bound to its place.** The authenticated data (AAD) ties each ciphertext to its project and
  field. A value copied into another project, or into another field of the same project, fails
  to decrypt.
- **Access control.** Services hold no key. They call `POST /api/internal/vault/reveal` with
  their own token. The gateway doesn't expose that endpoint, and each token has a policy:

  | Service | May read |
  |---|---|
  | auth-service | the project's auth secrets |
  | api-service | function secrets (passed to functions as `req.env`) |
  | queue-worker | database password, webhook signing secrets |

  Answers are cached in the service for up to 60 s and dropped as soon as the project's
  settings or secrets change. If a webhook secret can't be read, the delivery is retried
  later; it is never sent unsigned.
- **Never returned.** The APIs mask secrets (`••••••••`), and function secrets are write-only.
- **Audit.** Every reveal, denied reveal, rotation and migration goes to
  `control_plane.vault_audit`. Project members see their project's entries
  (`GET /api/projects/:id/vault`); platform admins see all of them (`GET /api/admin/vault/audit`).
- **Crypto-shredding.** Deleting a project deletes its data keys. Its secrets can't be recovered,
  even from old backups.

## Configuration

```bash
VAULT_MASTER_KEYS=k1:<openssl rand -hex 32>        # control-api only
VAULT_TOKEN_AUTH=<openssl rand -hex 32>             # one token per service
VAULT_TOKEN_API=<openssl rand -hex 32>
VAULT_TOKEN_QUEUE=<openssl rand -hex 32>
```

`make generate-secrets` prints all of these. **Keep a copy of the master keys off the server.**
Without them, no stored secret can be decrypted.

Without `VAULT_MASTER_KEYS`, a master key `k0` is derived from `SECRET_ENCRYPTION_KEY`. Other
services also hold that key, so set `VAULT_MASTER_KEYS` in production.

## Rotation

- **Master key.** Put a new key first: `VAULT_MASTER_KEYS=k2:<new>,k1:<old>`, then restart
  control-api. On start it re-wraps every data key with `k2`; `POST /api/admin/vault/rotate-master-key`
  does the same on demand. Once `GET /api/admin/vault` shows no data keys under `k1`, remove `k1`.
  No secret is re-encrypted.
- **Project data key.** `POST /api/projects/:id/vault/rotate` (owners / admins) creates a new data
  key, re-encrypts all of the project's secrets and retires the old key. The retired key is kept
  so that restored backups still decrypt.
- **Service tokens.** Change the token in `.env` and recreate control-api plus that service.

## Migration

On start, control-api moves plaintext secrets in project settings, and values encrypted in the
pre-vault format, into the vault. The first start on this installation sealed 721 secrets.
`GET /api/admin/vault` reports anything still not in vault format.

## Not in the vault (yet)

- **MFA seeds.** auth-service still encrypts them with `SECRET_ENCRYPTION_KEY` (a per-user hot path).
- **Backup files.** backup-worker encrypts them with `BACKUP_ENCRYPTION_KEY`, falling back to
  `SECRET_ENCRYPTION_KEY`. Set `BACKUP_ENCRYPTION_KEY` and keep it off the server.
- **Platform-wide credentials** (Stripe, Razorpay, Twilio defaults, SMTP) are read from the
  environment.
- **Job payloads.** Don't put secrets in queue job payloads such as `webhook.dispatch` `secret`;
  use function secrets.
- Services still connect to Postgres as the superuser, so a compromised service can read any
  table. That's the "PostgreSQL isolation" work item.
