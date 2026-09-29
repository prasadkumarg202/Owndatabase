/**
 * Schema migrations kept in your repository (Supabase-CLI style):
 *
 *   odb init [--github]                      create odb/migrations, odb/seed.sql (+ a GitHub Actions workflow)
 *   odb migration new <name>                 odb/migrations/<YYYYMMDDHHMMSS>_<name>.sql
 *   odb migration list <projectId>           local vs applied
 *   odb migration repair <projectId> <ver> --status applied|reverted
 *   odb db push <projectId> [--dry-run]      apply pending migrations in order (each in its own transaction)
 *   odb db pull <projectId> [--name n]       current remote schema → a new migration, marked applied
 *   odb db reset <projectId> --confirm <slug> [--no-seed]   empty the schema, re-apply every migration, run seed.sql
 *
 * The directory is ./odb/migrations (override with --dir or ODB_MIGRATIONS_DIR).
 * Files are sent with \n line endings, so checksums match across Windows / Linux checkouts.
 */
import type { Command } from 'commander';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { api } from './api.js';
import { dim, green, print, red, yellow } from './output.js';

interface LocalMigration { version: string; name: string; file: string; sql: string; checksum: string }

const FILE_RE = /^(\d{1,32})_([\w.-]*)\.sql$/;

function dirOf(o: { dir?: string }) {
  return resolve(o.dir ?? process.env['ODB_MIGRATIONS_DIR'] ?? join('odb', 'migrations'));
}

function readLocal(dir: string): LocalMigration[] {
  if (!existsSync(dir)) throw new Error(`No migrations directory at ${dir} (run \`odb init\` or pass --dir)`);
  const out: LocalMigration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    out.push({ version: m[1]!, name: m[2]!, file, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  const seen = new Set<string>();
  for (const m of out) {
    if (seen.has(m.version)) throw new Error(`Two migrations share version ${m.version}`);
    seen.add(m.version);
  }
  return out;
}

function timestamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'migration';

async function remoteMigrations(projectId: string): Promise<{ version: string; name: string; checksum: string; applied_at: string }[]> {
  return (await api(`/api/projects/${projectId}/migrations`)).data;
}

/** Local and remote must agree on everything already applied. Returns the pending local migrations. */
function plan(local: LocalMigration[], remote: { version: string; checksum: string }[]) {
  const localBy = new Map(local.map((m) => [m.version, m]));
  const remoteOnly = remote.filter((r) => !localBy.has(r.version)).map((r) => r.version);
  if (remoteOnly.length) {
    throw new Error(`The project has migrations that are not in ${'odb/migrations'}: ${remoteOnly.join(', ')}.\n` +
      'Pull them into your repository, or mark them reverted with `odb migration repair <project> <version> --status reverted`.');
  }
  const edited = remote.filter((r) => localBy.get(r.version)!.checksum !== r.checksum).map((r) => localBy.get(r.version)!.file);
  const applied = new Set(remote.map((r) => r.version));
  return { pending: local.filter((m) => !applied.has(m.version)), edited };
}

const GITHUB_WORKFLOW = `# Applies odb/migrations to your OwnDatabase project on every push to main
# (pull requests: dry run of the next pending migration).
#
# Secrets: ODB_URL (e.g. https://db.example.com), ODB_TOKEN (\`odb tokens create ci\`),
#          ODB_PROJECT_ID, and ODB_CLI_REPO_TOKEN if the OwnDatabase repository is private.
# Variable (optional): ODB_CLI_REPO, the OwnDatabase repository the CLI is built from.
name: Database migrations
on:
  push:
    branches: [main]
    paths: ['odb/migrations/**']
  pull_request:
    paths: ['odb/migrations/**']
jobs:
  migrate:
    runs-on: ubuntu-latest
    env:
      ODB_URL: \${{ secrets.ODB_URL }}
      ODB_TOKEN: \${{ secrets.ODB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: \${{ vars.ODB_CLI_REPO || 'prasadkumarg202/Owndatabase' }}
          token: \${{ secrets.ODB_CLI_REPO_TOKEN || github.token }}
          path: .odb
          sparse-checkout: platform/cli
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Build the odb CLI
        run: cd .odb/platform/cli && npm ci && npm run build && npm link
      - name: Check (pull requests)
        if: github.event_name == 'pull_request'
        run: odb db push \${{ secrets.ODB_PROJECT_ID }} --dry-run
      - name: Apply (main)
        if: github.event_name == 'push'
        run: odb db push \${{ secrets.ODB_PROJECT_ID }}
`;

export function registerMigrationCommands(program: Command, run: (fn: (...a: any[]) => Promise<void>) => (...a: any[]) => Promise<void>) {
  const json = () => !!program.opts()['json'];

  program.command('init').description('Create odb/migrations and odb/seed.sql in this directory')
    .option('--github', 'also write .github/workflows/odb-migrations.yml')
    .action(run(async (o) => {
      mkdirSync(join('odb', 'migrations'), { recursive: true });
      if (!existsSync(join('odb', 'seed.sql'))) writeFileSync(join('odb', 'seed.sql'), '-- Rows inserted by `odb db reset` after the migrations (development data).\n');
      console.log(green('✓ odb/migrations and odb/seed.sql ready'));
      if (o.github) {
        const f = join('.github', 'workflows', 'odb-migrations.yml');
        mkdirSync(dirname(f), { recursive: true });
        if (existsSync(f)) console.log(yellow(`${f} exists, left unchanged`));
        else { writeFileSync(f, GITHUB_WORKFLOW); console.log(green(`✓ ${f}`) + dim(' — add the ODB_URL, ODB_TOKEN and ODB_PROJECT_ID secrets')); }
      }
    }));

  const migration = program.command('migration').description('Schema migration files');
  migration.command('new <name>').option('--dir <dir>', 'migrations directory')
    .action(run(async (name, o) => {
      const dir = dirOf(o);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${timestamp()}_${slug(name)}.sql`);
      writeFileSync(file, `-- ${name}\n`);
      if (json()) return print({ file });
      console.log(green(`✓ ${file}`));
    }));

  migration.command('list <projectId>').option('--dir <dir>', 'migrations directory')
    .action(run(async (id, o) => {
      const local = existsSync(dirOf(o)) ? readLocal(dirOf(o)) : [];
      const remote = await remoteMigrations(id);
      const versions = [...new Set([...local.map((m) => m.version), ...remote.map((r) => r.version)])].sort();
      const rows = versions.map((v) => {
        const l = local.find((m) => m.version === v);
        const r = remote.find((m) => m.version === v);
        return { version: v, name: l?.name ?? r?.name ?? '', local: l ? 'yes' : 'no', applied: r ? r.applied_at : 'pending',
          note: l && r && l.checksum !== r.checksum ? 'edited after applying' : !l ? 'only on the project' : '' };
      });
      print(rows, ['version', 'name', 'local', 'applied', 'note']);
    }));

  migration.command('repair <projectId> <version>').requiredOption('--status <status>', 'applied | reverted')
    .option('--dir <dir>', 'migrations directory')
    .action(run(async (id, version, o) => {
      const local = existsSync(dirOf(o)) ? readLocal(dirOf(o)).find((m) => m.version === version) : undefined;
      await api(`/api/projects/${id}/migrations/repair`, { method: 'POST', json: { version, status: o.status, name: local?.name ?? '', sql: local?.sql } });
      console.log(green(`✓ ${version} marked ${o.status}`) + dim(' (nothing was executed)'));
    }));

  const db = program.commands.find((c) => c.name() === 'db')!;

  db.command('push <projectId>').description('Apply pending migrations from odb/migrations')
    .option('--dir <dir>', 'migrations directory').option('--dry-run', 'run each pending migration and roll it back')
    .action(run(async (id, o) => {
      const local = readLocal(dirOf(o));
      const { pending, edited } = plan(local, await remoteMigrations(id));
      if (edited.length) throw new Error(`Applied migrations were edited locally: ${edited.join(', ')}. Add a new migration instead.`);
      if (!pending.length) { if (json()) return print({ applied: [] }); console.log(green('✓ Up to date')); return; }
      const applied: string[] = [];
      for (const m of pending) {
        if (!json()) process.stdout.write(`${o.dryRun ? 'Checking' : 'Applying'} ${m.file} … `);
        try {
          const r = await api(`/api/projects/${id}/migrations`, { method: 'POST', json: { version: m.version, name: m.name, sql: m.sql, dry_run: !!o.dryRun } });
          applied.push(m.version);
          if (!json()) console.log(green(`ok`) + dim(` ${r.execution_ms ?? 0} ms`));
        } catch (e: any) {
          if (!json()) console.log(red('failed'));
          const b = e.body ?? {};
          throw new Error(`${m.file}: ${b.message ?? e.message}${b.position ? ` (at character ${b.position})` : ''}${b.hint ? `\nhint: ${b.hint}` : ''}\nNothing from this migration was applied; later migrations were not attempted.`);
        }
        // a dry run cannot validate later migrations that depend on this one
        if (o.dryRun) break;
      }
      if (json()) return print({ applied, dry_run: !!o.dryRun });
      if (o.dryRun && pending.length > 1) console.log(dim(`(dry run checks the first pending migration only; ${pending.length - 1} more depend on it)`));
    }));

  db.command('pull <projectId>').description("Save the project's current schema as a new migration (marked applied)")
    .option('--dir <dir>', 'migrations directory').option('--name <name>', 'migration name', 'remote_schema')
    .action(run(async (id, o) => {
      const dir = dirOf(o);
      mkdirSync(dir, { recursive: true });
      const { sql } = await api(`/api/projects/${id}/migrations/remote-schema`);
      const version = timestamp();
      const name = slug(o.name);
      const file = join(dir, `${version}_${name}.sql`);
      const body = sql.replace(/\r\n/g, '\n');
      writeFileSync(file, body);
      await api(`/api/projects/${id}/migrations/repair`, { method: 'POST', json: { version, status: 'applied', name, sql: body, source: 'pull' } });
      if (json()) return print({ file, version });
      console.log(green(`✓ ${file}`) + dim(' (recorded as applied on the project)'));
    }));

  db.command('reset <projectId>').description('Drop everything in the project schema, re-apply all migrations and seed.sql')
    .requiredOption('--confirm <slug>', 'the project slug').option('--dir <dir>', 'migrations directory').option('--no-seed', 'skip odb/seed.sql')
    .action(run(async (id, o) => {
      const local = readLocal(dirOf(o));
      await api(`/api/projects/${id}/database/reset`, { method: 'POST', json: { confirm: o.confirm } });
      if (!json()) console.log(yellow('Schema emptied.'));
      for (const m of local) {
        await api(`/api/projects/${id}/migrations`, { method: 'POST', json: { version: m.version, name: m.name, sql: m.sql } });
        if (!json()) console.log(`${green('✓')} ${m.file}`);
      }
      const seed = join(dirname(dirOf(o)), 'seed.sql');
      let seeded = false;
      if (o.seed !== false && existsSync(seed)) {
        const q = readFileSync(seed, 'utf8');
        if (q.replace(/--[^\n]*/g, '').trim()) {
          await api(`/api/projects/${id}/execute`, { method: 'POST', json: { query: q } });
          seeded = true;
          if (!json()) console.log(`${green('✓')} seed.sql`);
        }
      }
      if (json()) print({ applied: local.map((m) => m.version), seeded });
    }));
}
