import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().default(3003),
  DATABASE_URL: z.string().min(1),
  // Transaction-mode PgBouncer works: every request runs in one transaction
  // with SET LOCAL, and queries use the unnamed (non-prepared) protocol.
  POOLER_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SECRET_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  PUBLIC_URL: z.string().default('http://localhost'),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
  MAX_ROWS: z.coerce.number().default(1000),
  STATEMENT_TIMEOUT_MS: z.coerce.number().default(15000),
  RATE_LIMIT_ANON: z.coerce.number().default(600),
  RATE_LIMIT_AUTHENTICATED: z.coerce.number().default(1200),
  RATE_LIMIT_SERVICE: z.coerce.number().default(6000),
  FUNCTIONS_ENABLED: z.string().default('true').transform((v) => v !== 'false'),
  FUNCTIONS_MAX_CONCURRENCY: z.coerce.number().default(8),
});

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuration error:\n' + parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n'));
  process.exit(1);
}
export const config = parsed.data;
