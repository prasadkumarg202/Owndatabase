/**
 * Configuration — reads and validates all environment variables.
 * Fails fast with clear error messages if required variables are missing.
 */

import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),

  databaseUrl: z.string().startsWith('postgres'),
  poolerUrl: z.string().startsWith('postgres').optional(),
  redisUrl: z.string().startsWith('redis://'),

  jwtSecret: z.string().min(32),
  jwtExpiresIn: z.coerce.number().int().positive().default(3600),
  refreshTokenExpiresIn: z.coerce.number().int().positive().default(604800),

  // AES-256-GCM key, hex-encoded 32 bytes = 64 chars
  secretEncryptionKey: z.string().length(64).regex(/^[0-9a-f]+$/i),

  corsOrigins: z.string().transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  migrationsDir: z.string().default('/app/migrations'),
  migrateOnStart: bool.default('true'),

  rateLimitMax: z.coerce.number().int().positive().default(300),
  loginRateLimitMax: z.coerce.number().int().positive().default(10),
  // Comma-separated emails that are platform admins (in addition to is_platform_admin)
  platformAdminEmails: z.string().default('').transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),

  // Public URL the platform is reachable on (for generated endpoints)
  publicUrl: z.string().default('http://localhost'),

  // Observability backends (optional)
  prometheusUrl: z.string().optional(),
  lokiUrl: z.string().optional(),

  // SQL editor safety
  sqlStatementTimeoutMs: z.coerce.number().int().positive().default(15000),
  sqlMaxRows: z.coerce.number().int().positive().default(1000),

  // Extensions project owners may enable
  allowedExtensions: z
    .string()
    .default('postgis,vector,pg_trgm,hstore,citext,uuid-ossp,pgcrypto,pg_stat_statements,unaccent,btree_gin,btree_gist,tablefunc,fuzzystrmatch,ltree,intarray')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
});

function loadConfig() {
  const e = process.env;
  const result = configSchema.safeParse({
    nodeEnv: e['NODE_ENV'],
    port: e['PORT'],
    databaseUrl: e['DATABASE_URL'],
    poolerUrl: e['POOLER_URL'] || undefined,
    redisUrl: e['REDIS_URL'],
    jwtSecret: e['JWT_SECRET'],
    jwtExpiresIn: e['JWT_EXPIRES_IN'],
    refreshTokenExpiresIn: e['REFRESH_TOKEN_EXPIRES_IN'],
    secretEncryptionKey: e['SECRET_ENCRYPTION_KEY'],
    corsOrigins: e['CORS_ORIGINS'] ?? 'http://localhost:3001',
    logLevel: e['LOG_LEVEL'],
    migrationsDir: e['MIGRATIONS_DIR'],
    migrateOnStart: e['MIGRATE_ON_START'],
    rateLimitMax: e['RATE_LIMIT_MAX'],
    loginRateLimitMax: e['LOGIN_RATE_LIMIT_MAX'],
    platformAdminEmails: e['PLATFORM_ADMIN_EMAILS'],
    publicUrl: e['PUBLIC_URL'] ?? e['SITE_URL'],
    prometheusUrl: e['PROMETHEUS_URL'] || undefined,
    lokiUrl: e['LOKI_URL'] || undefined,
    sqlStatementTimeoutMs: e['SQL_STATEMENT_TIMEOUT_MS'],
    sqlMaxRows: e['SQL_MAX_ROWS'],
    allowedExtensions: e['ALLOWED_EXTENSIONS'],
  });

  if (!result.success) {
    const errors = result.error.errors.map((x) => `  ${x.path.join('.')}: ${x.message}`).join('\n');
    console.error(`\nConfiguration error:\n${errors}\n`);
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;
