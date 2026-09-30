/**
 * OwnDatabase Control Plane — Entry Point
 */

import { buildApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { db, testConnection } from './lib/db.js';
import { redis } from './lib/redis.js';
import { runMigrations } from './lib/migrate.js';
import { migrateAll } from './lib/vault.js';
import { ensureServiceRoles } from './lib/service-roles.js';
import { closeQueues } from './lib/queues.js';
import { shutdownTracing } from './lib/tracing.js';
import { startLimitWatcher, stopLimitWatcher } from './routes/limits.js';
import { startBilling, stopBilling } from './lib/billing.js';

// Wait for PostgreSQL (container start order is not a readiness guarantee)
for (let attempt = 1; ; attempt++) {
  try { await testConnection(); break; } catch (err) {
    if (attempt >= 30) { logger.fatal({ err }, 'PostgreSQL unreachable'); process.exit(1); }
    logger.warn({ attempt }, 'Waiting for PostgreSQL...');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (config.migrateOnStart) {
  try {
    const res = await runMigrations(db, config.migrationsDir, (m) => logger.info(m));
    logger.info({ applied: res.applied }, 'Migrations up to date');
  } catch (err) {
    logger.fatal({ err }, 'Migration failed');
    process.exit(1);
  }
}

// least-privilege logins for the services (migration 023)
await ensureServiceRoles();

// seal plaintext / legacy secrets, re-wrap data keys to the active master key (docs/vault.md)
await migrateAll();

const server = await buildApp();

try {
  await server.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port, env: config.nodeEnv }, 'OwnDatabase Control API started');
  startLimitWatcher();
  startBilling();
} catch (err) {
  logger.error(err, 'Failed to start server');
  process.exit(1);
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  try {
    stopLimitWatcher();
    stopBilling();
    await server.close();
    await closeQueues();
    await db.end({ timeout: 5 });
    redis.disconnect();
    await shutdownTracing();
    process.exit(0);
  } catch (err) {
    logger.error(err, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
