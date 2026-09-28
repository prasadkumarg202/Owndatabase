import postgres from 'postgres';
import { config } from '../config.js';

/** Catalog / platform queries (schema introspection, key lookups). */
export const db = postgres(config.DATABASE_URL, { max: 5, idle_timeout: 30, onnotice: () => {} });

/** Data queries — through PgBouncer when POOLER_URL is set. */
export const poolerDb = postgres(config.POOLER_URL || config.DATABASE_URL, {
  max: 20, idle_timeout: 30, prepare: false, onnotice: () => {},
});
