# Monitoring and alerts

| Piece | What it does |
|---|---|
| Prometheus | Scrapes every service's `/metrics`, PostgreSQL, Redis and the host; evaluates the alert rules in `infrastructure/prometheus/rules/alerts.yml` |
| Alertmanager | Groups firing alerts and sends them by email, Slack or webhook |
| Grafana | Dashboards (`infrastructure/grafana/dashboards`) |
| Loki + Promtail | Logs of every container (dashboard → Logs) |
| Tempo | Traces ([tracing.md](tracing.md)) |

## Alert rules

| Area | Alerts |
|---|---|
| PostgreSQL | down, connections high / near limit, slow queries, deadlocks, disk usage, replication lag |
| Redis | down, memory high |
| Services | a service down, high error rate, high latency, queue jobs failing |
| Host | CPU, memory, disk almost full |
| Backups | backup failed, no recent backup, WAL archiving failing / stale |
| HA (Patroni) | no leader, member down, replication lag, no sync standby, failover |

## Getting alerts

Set one or more of these in `.env` and recreate Alertmanager
(`docker compose up -d alertmanager`):

```bash
ALERT_EMAIL_TO=ops@example.com,oncall@example.com   # uses SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERT_WEBHOOK_URL=https://example.com/alerts         # Alertmanager's JSON webhook format
```

- Alerts are grouped by name and severity.
- The first notification goes out after `ALERT_GROUP_WAIT` (30 s by default).
- A still-firing alert is repeated every `ALERT_REPEAT_INTERVAL` (4 h by default).
- When an alert clears, a "resolved" message is sent.

With no receiver set, alerts are still collected. Platform admins see them on the dashboard's
**System status** page (`GET /api/observability/alerts`), which also shows where alerts are sent.
Alertmanager and Prometheus are not exposed through the gateway.

`tests/test_alerting.py` sends a synthetic alert through Alertmanager to a local receiver.
