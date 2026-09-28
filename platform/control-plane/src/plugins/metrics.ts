/**
 * Prometheus metrics plugin for Fastify.
 *
 * Exposes /metrics endpoint for Prometheus scraping.
 * Tracks HTTP request counts, durations, and error rates.
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  register,
} from 'prom-client';

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const httpActiveRequests = new Gauge({
  name: 'http_active_requests',
  help: 'Number of active HTTP requests',
});

// Collect default Node.js metrics (CPU, memory, event loop)
collectDefaultMetrics({ prefix: 'owndatabase_' });

const metricsPluginImpl: FastifyPluginAsync = async (server: FastifyInstance) => {
  // Track active requests
  server.addHook('onRequest', async () => {
    httpActiveRequests.inc();
  });

  // Record metrics after response
  server.addHook('onResponse', async (request, reply) => {
    httpActiveRequests.dec();

    // Skip /metrics and /health endpoints to avoid noise
    const route = request.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics' || route === '/health') return;

    httpRequestsTotal.inc({
      method: request.method,
      route,
      status: reply.statusCode,
    });

    const duration = reply.elapsedTime / 1000;
    httpRequestDuration.observe(
      { method: request.method, route, status: reply.statusCode },
      duration
    );
  });

  // Expose /metrics endpoint
  server.get(
    '/metrics',
    {
      schema: {
        hide: true, // Don't include in OpenAPI docs
      },
    },
    async (_request, reply) => {
      const metrics = await register.metrics();
      void reply
        .header('Content-Type', register.contentType)
        .send(metrics);
    }
  );
};

export const metricsPlugin = fp(metricsPluginImpl, {
  name: 'metrics',
});
