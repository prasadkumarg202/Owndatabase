# Usage limits

Each project can have limits, set by **platform administrators** (members only
see them): Project → Settings → Usage & limits, or

```http
PUT /api/projects/:id/limits
{ "api_requests_per_day": 500000, "storage_bytes": 1073741824, "auth_users": null }
```

`null` removes a limit (unlimited). `GET /api/projects/:id/limits` returns the
limits, current usage and whether the project is read-only. New projects get
`DEFAULT_PROJECT_LIMITS` (JSON, on the control API); existing ones are unlimited
until a limit is set.

| Limit | Counted | When exceeded |
|---|---|---|
| `api_requests_per_day` | REST + RPC requests per UTC day | `429 Quota Exceeded`, `Retry-After` until 00:00 UTC; responses carry `X-Quota-Limit` / `X-Quota-Remaining` |
| `function_invocations_per_day` | function calls per UTC day | `429`, same as above |
| `storage_bytes` | bytes of all stored objects | upload / copy refused with `402` (overwriting counts only the difference) |
| `auth_users` | end users (not deleted) | sign-up, OTP / OAuth sign-up and admin create refused with `402` |
| `realtime_connections` | concurrent WebSockets, **per realtime instance** | connection gets `{type: error, code: quota_exceeded}` and close code 4029 |
| `database_bytes` | size of the project schema, checked every minute | project becomes **read-only**: REST inserts / updates / RPC POST get `402`; reads and deletes keep working so data can be trimmed. It switches back automatically once under the limit (or the limit is raised). |

Read-only mode is enforced by the data API. Direct PostgreSQL connections with
the project's own role are not blocked.

Changes of read-only state are written to the project's audit log
(`project.db_read_only_on` / `_off`). Limit changes take effect within a
moment (services refresh the project on `odb:project-changed`).
