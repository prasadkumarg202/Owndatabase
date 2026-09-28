/**
 * Migration runner.
 *
 * Applies every `NNN_*.sql` file in MIGRATIONS_DIR exactly once, in order,
 * recording each in control_plane.schema_migrations.
 *
 * Databases created by the original init script already contain 001–003;
 * those are detected and recorded as applied (baseline) instead of re-run.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function listMigrationFiles(dir: string): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

export async function runMigrations(
  sql: postgres.Sql<any>,
  dir: string,
  log: (msg: string) => void = () => {},
): Promise<MigrationResult> {
  // Serialise concurrent runners (several containers may start at once)
  const lockId = 734_221_901;
  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(${lockId})`;

    await reserved.unsafe(`
      CREATE SCHEMA IF NOT EXISTS control_plane;
      CREATE TABLE IF NOT EXISTS control_plane.schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).simple();

    const files = await listMigrationFiles(dir);
    const appliedRows = await reserved<{ name: string }[]>`SELECT name FROM control_plane.schema_migrations`;
    const applied = new Set(appliedRows.map((r) => r.name));

    // Baseline: schemas created by the legacy init script
    if (applied.size === 0) {
      const [legacy] = await reserved<{ cp: string | null; au: string | null; st: string | null }[]>`
        SELECT to_regclass('control_plane.projects')::text AS cp,
               to_regclass('auth.users')::text AS au,
               to_regclass('storage.buckets')::text AS st`;
      const baseline: Record<string, boolean> = {
        '001': !!legacy?.cp, '002': !!legacy?.au, '003': !!legacy?.st,
      };
      for (const f of files) {
        const prefix = f.slice(0, 3);
        if (baseline[prefix]) {
          const body = await readFile(join(dir, f), 'utf8');
          await reserved`INSERT INTO control_plane.schema_migrations (name, checksum) VALUES (${f}, ${checksum(body)}) ON CONFLICT DO NOTHING`;
          applied.add(f);
          log(`baseline ${f}`);
        }
      }
    }

    const result: MigrationResult = { applied: [], skipped: [] };
    for (const f of files) {
      if (applied.has(f)) { result.skipped.push(f); continue; }
      const body = await readFile(join(dir, f), 'utf8');
      log(`applying ${f}`);
      await reserved.unsafe('BEGIN').simple();
      try {
        await reserved.unsafe(body).simple();
        await reserved.unsafe('RESET search_path').simple();
        await reserved`INSERT INTO control_plane.schema_migrations (name, checksum) VALUES (${f}, ${checksum(body)})`;
        await reserved.unsafe('COMMIT').simple();
      } catch (err) {
        await reserved.unsafe('ROLLBACK').simple();
        throw new Error(`Migration ${f} failed: ${(err as Error).message}`);
      }
      result.applied.push(f);
    }
    return result;
  } finally {
    await reserved`SELECT pg_advisory_unlock(${lockId})`.catch(() => {});
    reserved.release();
  }
}

function checksum(body: string) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}
