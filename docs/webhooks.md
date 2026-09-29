# Database webhooks

Send an HTTP request whenever rows in a project table are inserted, updated or
deleted. Configure them in Project → Webhooks, or through the API:

```http
POST /api/projects/:id/webhooks
{ "name": "orders-to-crm", "table": "orders", "events": ["insert", "update"],
  "url": "https://crm.example.com/hooks/orders", "method": "POST",
  "headers": { "Authorization": "Bearer …" }, "secret": "whsec_…", "timeout_ms": 5000 }
```

`PATCH` / `DELETE /api/projects/:id/webhooks/:hookId`, delivery history at
`GET …/:hookId/deliveries`, manual redelivery at `POST …/deliveries/:eventId/retry`.

## Request

```json
{ "type": "INSERT", "table": "orders", "schema": "proj_…",
  "record": { "id": 1, "status": "new" }, "old_record": null,
  "commit_timestamp": "2026-09-29T16:20:00.123456Z" }
```

`record` is null for DELETE and `old_record` is null for INSERT — the same shape
as Supabase database webhooks. Headers: `content-type: application/json`,
`x-odb-webhook-id`, `x-odb-event-id` (use it to de-duplicate), your custom
headers, and with a secret:

```
x-odb-timestamp: 1790700000
x-odb-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

## Delivery guarantees

- A row trigger writes the change to an outbox table **in the same transaction**:
  rolled-back changes never fire, committed ones are never lost.
- The queue worker delivers from the outbox (woken by NOTIFY, polling every 5 s).
  Any 2xx is success. Otherwise it retries after 10 s, 30 s, 2 min, 10 min and
  30 min, then marks the delivery failed (redeliver it from the dashboard).
- At-least-once: a receiver may see the same `x-odb-event-id` twice (for
  example if the worker crashes mid-request). Deliveries are not ordered.
- Delivered events are kept 7 days, failed ones 30 days.
- Targets on private / internal addresses are refused unless the worker runs
  with `WEBHOOK_ALLOW_PRIVATE=true`; redirects are not followed.

## Notes

- Dropping and recreating a table removes its trigger; the webhook list shows
  "trigger missing" and saving the webhook reinstalls it.
- The trigger function checks that the table belongs to the webhook's
  project and cannot be attached by project roles, so one project cannot feed
  another project's webhook.
- Each change adds a row to the outbox inside your transaction; for bulk
  loads of millions of rows, pause the webhook first.
