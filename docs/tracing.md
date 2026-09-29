# Distributed tracing (OpenTelemetry)

The control API and the data-plane services (REST/RPC + functions, auth,
storage, realtime) export OpenTelemetry traces over OTLP/HTTP. The stack ships
**Grafana Tempo** to store them; open Grafana → Explore → **Tempo**.

| Span | Where |
|---|---|
| `GET /v1/:projectId/:table`, `POST /api/projects/:id/…` | one SERVER span per request, every service |
| `db.transaction` | each REST/RPC database transaction (role, project) |
| `function.invoke` | a function call through the isolated runtime |

- Every response carries **`x-trace-id`**; paste it into Grafana to see the request.
- An incoming W3C **`traceparent`** header is continued, so a trace started in
  your app (or your own OpenTelemetry setup) flows through OwnDatabase.
- Spans carry `odb.project_id`, `http.route`, status code and client address;
  errors are recorded on the span. Health and metrics endpoints are not traced.
- From a trace, Grafana can jump to the matching Loki logs.

## Configuration

| Env (compose, per service) | Default | |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://tempo:4318` | any OTLP/HTTP collector (Tempo, Jaeger, Honeycomb, Grafana Cloud…); **empty disables tracing** |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | fraction of new traces kept, e.g. `0.1`; child spans follow the parent's decision |
| `OTEL_SERVICE_NAME` | the service name | override `service.name` |
| `TEMPO_RETENTION` | `72h` | how long Tempo keeps traces |

The tracing code is `platform/shared/tracing.ts` (copied into each service by
`scripts/sync-shared.sh`). It uses explicit spans rather than
auto-instrumentation, which does not cover the `postgres` client the services use.
