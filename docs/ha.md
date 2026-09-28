# High availability (Phase 10)

> **Status: untested template.** The files described here were written as a
> starting point and have not been run end-to-end. Rehearse failover on
> throw-away servers before trusting them with data.

## What is provided

| File | Purpose |
|---|---|
| `infrastructure/ha/docker-compose.ha.yml` | 3 × etcd (DCS), 3 × Patroni/Spilo PostgreSQL 16, HAProxy |
| `infrastructure/ha/haproxy.cfg` | `:5000` → current primary, `:5001` → healthy replicas (lag ≤ 10 MB), `:7000` stats |

Patroni exposes a REST API on `:8008`. `GET /primary` returns 200 only on the
leader and `GET /replica` only on a healthy streaming replica, so HAProxy's
health checks follow a failover automatically.

## Wiring it to OwnDatabase

1. Set `PATRONI_REPLICATION_PASSWORD` and `PATRONI_ADMIN_PASSWORD` in `.env`
   (generate them locally, e.g. `openssl rand -hex 24`).
2. Start the cluster: `docker compose -f infrastructure/ha/docker-compose.ha.yml up -d`.
3. Run the role bootstrap once against the primary (`:5000`):
   `infrastructure/postgres/init/00_init.sh` creates the extensions and the
   `anon` / `authenticated` / `service_role` roles. Migrations then run
   automatically when `control-api` starts.
4. Point PgBouncer's upstream at `haproxy:5000` and every service's
   `DATABASE_URL` at PgBouncer, as in the single-node setup.
5. `realtime-service` uses `LISTEN`, which needs a session connection to the
   **primary**: give it a direct `haproxy:5000` URL, not PgBouncer
   (transaction pooling drops LISTEN).

## Known gaps

- Nothing in the application routes reads to `:5001` yet; replicas are only
  useful for failover and for manual read-only analytics connections.
- `synchronous_mode: true` trades a little write latency for zero data loss
  on failover. Turn it off if you run only two data nodes.
- Multi-VPS: put each `pgN` and `etcdN` on its own host, replace the service
  names with private IPs / DNS, and keep etcd on an odd number of hosts. Use a
  private network (WireGuard or the provider's VPC) — none of these ports
  should be reachable from the internet.
- Replication monitoring: add the Patroni endpoints to Prometheus
  (`pgN:8008/metrics`) and alert on `patroni_replication_lag` — not included.
