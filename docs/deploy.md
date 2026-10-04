# Deploying to a VPS

How the platform runs at `https://aapstack.tech` on a Hostinger KVM 4 (4 vCPU, 16 GB RAM, 200 GB,
Ubuntu 24.04). Any Ubuntu 22.04/24.04 server with 16 GB RAM works the same way.

## 1. Server

- **OS:** plain **Ubuntu 24.04**. Don't install a control panel (Coolify, Dokploy, cPanel, ...) or
  "Docker and Traefik": they take ports 80/443, which Caddy needs.
- **SSH key:** add one when the server is created.
- **DNS:** add these records at the domain's DNS:

  | Type | Name | Value |
  |---|---|---|
  | A | `@` | the server's IPv4 |
  | A | `*` | the server's IPv4 (optional: subdomains later) |

## 2. Prepare the server (once)

```bash
ssh root@SERVER_IP
git clone https://github.com/prasadkumarg202/Owndatabase.git /opt/owndatabase
cd /opt/owndatabase
bash scripts/server-setup.sh          # Docker, firewall (22/80/443), 4 GB swap, security updates, fail2ban
```

## 3. Configuration

```bash
bash scripts/make-prod-env.sh aapstack.tech you@example.com   # fresh secrets; never overwrites .env
nano .env                                                      # add the settings below
```

- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`. Without them, sign-up and
  password-reset emails aren't sent.
- **SMS:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `SMS_TEMPLATE`.
- **Alerts:** `ALERT_EMAIL_TO` (uses SMTP) or `ALERT_SLACK_WEBHOOK_URL`.
- **Billing (optional):** `BILLING_PROVIDER`, `STRIPE_*` / `RAZORPAY_*`.

**Copy `VAULT_MASTER_KEYS` and `BACKUP_ENCRYPTION_KEY` to a password manager.** Without them, the
stored secrets and the backups can't be decrypted.

Don't copy a development `.env` to the server. It turns on test-only settings: `AUTH_DEV_MAILBOX`
exposes emails and SMS codes over HTTP, and the `OAUTH_MOCK_*` settings send OAuth to a test server.

## 4. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose ps                                  # all "healthy" after a few minutes
```

`docker-compose.prod.yml` builds the compiled production images (non-root, no dev dependencies, no
source mounts). The first build takes about 10–15 minutes.

Caddy gets a Let's Encrypt certificate for `PRIMARY_DOMAIN` as soon as DNS points at the server; plain
HTTP requests for the domain are redirected to HTTPS. Then:

1. Open `https://aapstack.tech` and sign up with the admin email. That account is a platform admin
   (`PLATFORM_ADMIN_EMAILS`).
2. Create a project. Apps connect with `createClient('https://aapstack.tech/p/<projectId>', anonKey)`
   ([sdks.md](sdks.md)).

## Updating

```bash
cd /opt/owndatabase
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically when control-api starts.

## Operations

- **Backups:** project backups (backup worker) and pgBackRest write to Docker volumes on this server.
  Copy them off the server regularly, for example to Cloudflare R2 or Backblaze B2 with `rclone`
  ([backups.md](backups.md)), and turn on Hostinger's VPS snapshots.
- **Logs:**
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f --tail 100 <service>`.
  Grafana is at `https://aapstack.tech/grafana` (user `admin`, `GRAFANA_PASSWORD` from `.env`).
- **Database access:** Postgres isn't exposed. Use an SSH tunnel, or
  `docker exec -it owndatabase-postgres psql -U postgres owndatabase`.
- **Disk:** `docker system df`; `docker image prune -f` after updates.
