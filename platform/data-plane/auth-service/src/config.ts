import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().default(3002),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SECRET_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  JWT_EXPIRES_IN: z.coerce.number().default(3600),
  REFRESH_TOKEN_EXPIRES_IN: z.coerce.number().default(604800),
  // Platform-wide OAuth fallbacks (projects can set their own in Auth settings)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SITE_URL: z.string().default('http://localhost'),
  // Public base URL of the auth service (used for OAuth callback URLs)
  AUTH_PUBLIC_URL: z.string().optional(),
  // Dev only: capture outgoing emails in Redis and expose them at /v1/:projectId/_dev/emails
  AUTH_DEV_MAILBOX: z.string().optional().transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('development'),
});

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuration error:\n' + parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n'));
  process.exit(1);
}
export const config = parsed.data;
export const authPublicUrl = (config.AUTH_PUBLIC_URL ?? `${config.SITE_URL.replace(/\/$/, '')}/auth`).replace(/\/$/, '');
