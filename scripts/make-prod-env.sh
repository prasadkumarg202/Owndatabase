#!/usr/bin/env bash
# Writes a production .env with fresh random secrets (docs/deploy.md):
#   bash scripts/make-prod-env.sh <domain> <admin email>
# Never overwrites an existing .env. Afterwards, add SMTP / Twilio / alert settings by hand, and
# copy VAULT_MASTER_KEYS and BACKUP_ENCRYPTION_KEY somewhere off this server.
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN_NAME="${1:?usage: make-prod-env.sh <domain> <admin email>}"
ADMIN_EMAIL="${2:?usage: make-prod-env.sh <domain> <admin email>}"
[ -e .env ] && { echo ".env already exists: not overwriting it"; exit 1; }

hex() { openssl rand -hex "$1"; }
cp .env.example .env
chmod 600 .env
set_kv() {  # replace KEY=... or append it
  local k="$1" v="$2"
  if grep -q "^$k=" .env; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    echo "$k=$v" >> .env
  fi
  chmod 600 .env
}

# site
set_kv DOMAIN "$DOMAIN_NAME"
set_kv PRIMARY_DOMAIN "$DOMAIN_NAME"
set_kv SITE_URL "https://$DOMAIN_NAME"
set_kv CORS_ORIGINS "https://$DOMAIN_NAME"
set_kv NEXT_PUBLIC_CONTROL_API_URL "https://$DOMAIN_NAME/api"
set_kv NODE_ENV production
set_kv PLATFORM_ADMIN_EMAILS "$ADMIN_EMAIL"
set_kv SMTP_FROM "noreply@$DOMAIN_NAME"
# development helpers stay off
set_kv AUTH_DEV_MAILBOX false
set_kv WEBHOOK_ALLOW_PRIVATE false
set_kv SMS_DEFAULT_COUNTRY_CODE 91

# secrets
set_kv POSTGRES_PASSWORD "$(hex 24)"
set_kv REDIS_PASSWORD "$(hex 24)"
set_kv JWT_SECRET "$(hex 32)"
set_kv SECRET_ENCRYPTION_KEY "$(hex 32)"
set_kv VAULT_MASTER_KEYS "k1:$(hex 32)"
for t in AUTH API QUEUE; do set_kv "VAULT_TOKEN_$t" "$(hex 32)"; done
for r in AUTH API REALTIME STORAGE WORKER CRON; do set_kv "DB_PASSWORD_$r" "$(hex 24)"; done
set_kv BACKUP_ENCRYPTION_KEY "$(hex 32)"
set_kv PGBACKREST_CIPHER_PASS "$(hex 32)"
set_kv FUNCTIONS_RUNTIME_TOKEN "$(hex 32)"
set_kv GRAFANA_PASSWORD "$(hex 12)"
S3_PASS="$(hex 24)"
set_kv MINIO_ROOT_USER odbstorage
set_kv MINIO_ROOT_PASSWORD "$S3_PASS"
set_kv S3_ACCESS_KEY odbstorage
set_kv S3_SECRET_KEY "$S3_PASS"

echo "✓ .env written for https://$DOMAIN_NAME"
echo "  Next: add SMTP_*, TWILIO_* / SMS_*, ALERT_EMAIL_TO, then save a copy of these off the server:"
grep -E '^(VAULT_MASTER_KEYS|BACKUP_ENCRYPTION_KEY)=' .env | sed 's/=.*/=…/'
