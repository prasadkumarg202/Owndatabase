/**
 * CLI: node dist/cli/migrate.js [up|status]
 */
import postgres from 'postgres';
import { runMigrations, listMigrationFiles } from '../lib/migrate.js';

const url = process.env['DATABASE_URL'];
const dir = process.env['MIGRATIONS_DIR'] ?? '/app/migrations';
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }

const sql = postgres(url, { max: 1, onnotice: () => {} });
const cmd = process.argv[2] ?? 'up';

try {
  if (cmd === 'status') {
    const files = await listMigrationFiles(dir);
    const rows = await sql<{ name: string; applied_at: Date }[]>`
      SELECT name, applied_at FROM control_plane.schema_migrations`.catch(() => []);
    const done = new Map(rows.map((r) => [r.name, r.applied_at]));
    for (const f of files) console.log(`${done.has(f) ? '✓' : '·'} ${f}${done.has(f) ? '  ' + done.get(f)!.toISOString() : ''}`);
  } else if (cmd === 'up') {
    const res = await runMigrations(sql, dir, (m) => console.log('→ ' + m));
    console.log(`✓ ${res.applied.length} applied, ${res.skipped.length} already up to date`);
  } else {
    console.error(`Unknown command '${cmd}'. Rollbacks are not supported: write a new forward migration instead.`);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
