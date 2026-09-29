/**
 * OpenTelemetry tracing (CANONICAL COPY: platform/shared/tracing.ts, copied by
 * scripts/sync-shared.sh into every service that traces).
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://tempo:4318); then
 * spans are exported over OTLP/HTTP. Each Fastify request becomes a SERVER span
 * (continuing an incoming W3C `traceparent`), responses carry `x-trace-id`,
 * withSpan() wraps inner work (database transactions, calls to other services)
 * and injectTrace() propagates the trace on outgoing requests.
 */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { FastifyInstance, FastifyRequest } from 'fastify';

let provider: NodeTracerProvider | null = null;
let serviceName = 'owndatabase';

export function tracingEnabled() {
  return provider !== null;
}

export function initTracing(name: string) {
  serviceName = name;
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint || provider) return;
  const ratio = Number(process.env['OTEL_TRACES_SAMPLER_ARG'] ?? '1');
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': process.env['OTEL_SERVICE_NAME'] ?? name,
      'service.namespace': 'owndatabase',
      'deployment.environment': process.env['NODE_ENV'] ?? 'development',
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }), { scheduledDelayMillis: 1000 })],
    // OTEL_TRACES_SAMPLER_ARG=0.1 keeps 10% of new traces (children follow their parent's decision)
    ...(ratio < 1 ? { sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }) } : {}),
  });
  provider.register(); // global provider, AsyncLocalStorage context, W3C trace-context propagation
}

export async function shutdownTracing() {
  await provider?.shutdown().catch(() => {});
}

const tracer = () => trace.getTracer(serviceName);

/** Runs fn inside a child span of the current one (a no-op span when tracing is off). */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, kind: SpanKind = SpanKind.INTERNAL): Promise<T> {
  if (!provider) return fn(trace.wrapSpanContext({ traceId: '', spanId: '', traceFlags: 0 }));
  return tracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Adds traceparent/tracestate for the current span to outgoing request headers. */
export function injectTrace(headers: Record<string, string> = {}): Record<string, string> {
  if (provider) propagation.inject(context.active(), headers);
  return headers;
}

/** One SERVER span per request. Register before the routes. */
export function tracingPlugin(server: FastifyInstance) {
  if (!provider) return;
  const spans = new WeakMap<FastifyRequest, Span>();
  server.addHook('onRequest', (req, reply, done) => {
    if (req.url === '/health' || req.url === '/metrics' || req.url.startsWith('/health/')) return done();
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer().startSpan(`${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': req.method,
        'url.path': req.url.split('?')[0],
        'client.address': req.ip,
        'user_agent.original': String(req.headers['user-agent'] ?? ''),
      },
    }, parent);
    spans.set(req, span);
    reply.header('x-trace-id', span.spanContext().traceId);
    // the rest of the request (hooks, handler, awaited work) runs in this span's context
    context.with(trace.setSpan(parent, span), done);
  });
  server.addHook('onError', (req, _reply, err, done) => {
    const span = spans.get(req);
    if (span) { span.recordException(err); span.setStatus({ code: SpanStatusCode.ERROR, message: err.message }); }
    done();
  });
  server.addHook('onResponse', (req, reply, done) => {
    const span = spans.get(req);
    if (span) {
      const projectId = (req.params as Record<string, string> | undefined)?.['projectId'];
      span.setAttributes({
        'http.response.status_code': reply.statusCode,
        'http.route': req.routeOptions?.url ?? '',
        ...(projectId ? { 'odb.project_id': projectId } : {}),
      });
      if (req.routeOptions?.url) span.updateName(`${req.method} ${req.routeOptions.url}`);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    done();
  });
}
