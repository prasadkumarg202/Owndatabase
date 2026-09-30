#!/bin/sh
# Builds the Alertmanager config from environment variables (docs/monitoring.md), then starts it.
#   ALERT_EMAIL_TO           comma-separated addresses (uses SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM)
#   ALERT_SLACK_WEBHOOK_URL  Slack incoming webhook
#   ALERT_WEBHOOK_URL        any URL that accepts Alertmanager's JSON webhook
# Without any of them, alerts are still collected (GET /api/admin/alerts) but not sent anywhere.
set -eu

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
CFG=/tmp/alertmanager.yml

{
  echo "global:"
  echo "  resolve_timeout: 5m"
  if [ -n "${ALERT_EMAIL_TO:-}" ] && [ -n "${SMTP_HOST:-}" ]; then
    echo "  smtp_smarthost: $(q "${SMTP_HOST}:${SMTP_PORT:-587}")"
    echo "  smtp_from: $(q "${SMTP_FROM:-alerts@localhost}")"
    if [ -n "${SMTP_USER:-}" ]; then
      echo "  smtp_auth_username: $(q "${SMTP_USER}")"
      echo "  smtp_auth_password: $(q "${SMTP_PASSWORD:-}")"
    fi
    echo "  smtp_require_tls: ${SMTP_REQUIRE_TLS:-true}"
  fi
  echo "route:"
  echo "  receiver: default"
  echo "  group_by: [alertname, severity]"
  echo "  group_wait: ${ALERT_GROUP_WAIT:-30s}"
  echo "  group_interval: 5m"
  echo "  repeat_interval: ${ALERT_REPEAT_INTERVAL:-4h}"
  echo "receivers:"
  echo "  - name: default"
  if [ -n "${ALERT_EMAIL_TO:-}" ] && [ -n "${SMTP_HOST:-}" ]; then
    echo "    email_configs:"
    echo "      - to: $(q "${ALERT_EMAIL_TO}")"
    echo "        send_resolved: true"
  fi
  if [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]; then
    echo "    slack_configs:"
    echo "      - api_url: $(q "${ALERT_SLACK_WEBHOOK_URL}")"
    echo "        send_resolved: true"
    echo "        title: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}'"
    echo "        text: '{{ range .Alerts }}{{ .Annotations.summary }} {{ .Annotations.description }}{{ \"\\n\" }}{{ end }}'"
  fi
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    echo "    webhook_configs:"
    echo "      - url: $(q "${ALERT_WEBHOOK_URL}")"
    echo "        send_resolved: true"
  fi
} > "$CFG"

exec /bin/alertmanager --config.file="$CFG" --storage.path=/alertmanager "$@"
