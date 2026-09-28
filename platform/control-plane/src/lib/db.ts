/**
 * Database connection — PostgreSQL via postgres.js
 *
 * Column names are returned exactly as PostgreSQL names them (snake_case).
 * The public API is snake_case too, so rows can be returned unchanged.
 */

import postgres from 'postgres';
import { config } from '../config.js';
import { logger } from './logger.js';

export type Sql = postgres.Sql<Record<string, unknown>>;

export const db = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: (notice) => logger.debug({ notice: notice['message'] }, 'PostgreSQL notice'),
});

export async function testConnection(): Promise<void> {
  await db`SELECT 1 AS ok`;
}

/** Quote an SQL identifier safely. */
export function ident(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Quote an SQL string literal safely. */
export function literal(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Validates a plain identifier (letters, digits, underscore; must not start with a digit). */
export function isSafeIdent(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name);
}
