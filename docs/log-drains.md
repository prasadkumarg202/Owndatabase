# Log drains

Forward a project's logs to your own tools. Set drains up in the dashboard (**Logs → Log drains**) or with
`/api/projects/:id/log-drains`.

| Destination | Settings | Request |
|---|---|---|
| Webhook | `url` (https), optional signing `secret` | `POST { drain_id, project_id, events: [...] }` with `x-odb-timestamp` and `x-odb-signature: sha256=HMAC(secret, "<timestamp>.<body>")`, as database webhooks |
| Datadog | API key (`secret`), `site` (datadoghq.com, datadoghq.eu, us3/us5, ap1, ddog-gov) | `POST https://http-intake.logs.<site>/api/v2/logs` with `DD-API-KEY`; tagged `project_id:<id>,source:<source>` |
| Better Stack (Logtail) | source token (`secret`), optional ingesting host (`url`) | `POST https://in.logs.betterstack.com` with `Authorization: Bearer <token>` |

## What gets sent

Each drain picks any of these sources:

| Source | Events |
|---|---|
| `audit` | changes made in the dashboard or API (keys, settings, functions, ...) |
| `auth` | sign-ups, sign-ins, failures, MFA, password resets |
| `functions` | every function run: status, duration, console output, errors |
| `platform` | lines from the API services that mention the project: requests, errors |

Every event has `timestamp`, `source`, `event`, `level`, `message`, `project_id`, and where available
`actor`, `ip_address` and `metadata`.

## Delivery

- **Timing:** the queue worker sends new events every 5 seconds, in batches of up to 500. A new drain
  starts from the moment it's created; history isn't replayed.
- **Order and duplicates:** delivery is in order and at-least-once, using a cursor per source. A batch
  that failed is sent again, so a receiver may see an event twice.
- **Failures:** retries back off from 10 seconds up to an hour. After 50 failures in a row the drain is
  switched off. The dashboard shows the last error, and switching the drain back on starts over.
- **Secrets:** API keys and signing secrets are sealed by the vault ([vault.md](vault.md)) and never
  returned. **Send test** delivers one event right away and reports the result.
- **Limits:** up to 5 drains per project, managed by owners and admins. URLs must be public `https`
  addresses.
