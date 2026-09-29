#!/usr/bin/env node
/**
 * odb — OwnDatabase CLI
 *
 *   odb login [--email you@x.com]            odb projects list | create <name> | info <id>
 *   odb db tables <project> | exec <project> -q "select 1" | dump <project>
 *   odb keys list|create|revoke|rotate|rotate-all   odb secrets list|set|delete   odb storage buckets|create-bucket|upload|ls
 *   odb functions list|deploy|logs|invoke   odb backups list|create|restore   odb logs <project>   odb status
 *   odb init   odb migration new|list|repair   odb db push|pull|reset   odb tokens list|create|revoke
 *
 * Global: --json for machine-readable output. Env: ODB_URL, ODB_TOKEN, ODB_API_KEY, ODB_CONFIG.
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { api, request } from './api.js';
import { configPath, loadConfig, saveConfig } from './config.js';
import { bold, dim, fail, green, print, prompt, readStdin, setJson, table, yellow } from './output.js';
import { registerMigrationCommands } from './migrations.js';

const program = new Command();
program.name('odb').description('OwnDatabase CLI').version('0.2.0').option('--json', 'JSON output');
program.hook('preAction', () => setJson(!!program.opts()['json']));

const run = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => { try { await fn(...a); } catch (e) { fail(e); } };

// ── auth ────────────────────────────────────────────────────────────────────
program.command('login').description('Sign in to the platform')
  .option('--email <email>').option('--password <password>', 'or set ODB_PASSWORD').option('--url <url>', 'platform URL, e.g. https://db.example.com')
  .action(run(async (o) => {
    if (o.url) saveConfig({ ...loadConfig(), url: o.url });
    const email = o.email ?? await prompt('Email: ');
    const password = o.password ?? process.env['ODB_PASSWORD'] ?? await prompt('Password: ', true);
    const r = await api('/api/auth/login', { method: 'POST', json: { email, password } });
    saveConfig({ ...loadConfig(), access_token: r.access_token, refresh_token: r.refresh_token, email });
    console.log(green(`✓ Logged in as ${email}`) + dim(`  (${configPath})`));
  }));

program.command('logout').description('Sign out and forget credentials').option('--all', 'sign out every device')
  .action(run(async (o) => {
    await api(`/api/auth/logout${o.all ? '?all=true' : ''}`, { method: 'POST' }).catch(() => {});
    const { url } = loadConfig();
    saveConfig({ url });
    console.log(green('✓ Logged out'));
  }));

program.command('whoami').description('Show the signed-in user').action(run(async () => print(await api('/api/auth/me'))));

program.command('status').description('Health of every platform service').action(run(async () => {
  const r = await api('/api/observability/services');
  print(r.data, ['name', 'status', 'latency_ms']);
}));

// ── projects ────────────────────────────────────────────────────────────────
const projects = program.command('projects').description('Manage projects');
projects.command('list').action(run(async () => print((await api('/api/projects')).data, ['id', 'name', 'slug', 'status', 'organization_name'])));
projects.command('create <name>').option('--slug <slug>').option('--org <organizationId>')
  .action(run(async (name, o) => {
    const r = await api('/api/projects', { method: 'POST', json: { name, slug: o.slug, organization_id: o.org } });
    if (program.opts()['json']) return print(r);
    console.log(green(`✓ Project ${r.name} created`) + dim(` (${r.id})`));
    console.log(`${bold('REST')}      ${r.endpoints.rest_url}\n${bold('Auth')}      ${r.endpoints.auth_url}\n${bold('Storage')}   ${r.endpoints.storage_url}\n${bold('Realtime')}  ${r.endpoints.realtime_url}`);
    console.log(yellow('\nAPI keys (shown once — store them now):'));
    console.log(`  anon          ${r.api_keys.anon}\n  service_role  ${r.api_keys.service_role}`);
  }));
projects.command('info <projectId>').action(run(async (id) => {
  const r = await api(`/api/projects/${id}`);
  print({ id: r.id, name: r.name, slug: r.slug, status: r.status, schema: r.db_schema, organization: r.organization_name, ...r.endpoints, ...r.stats });
}));
projects.command('delete <projectId>').requiredOption('--confirm <slug>', 'type the project slug to confirm')
  .action(run(async (id, o) => { await api(`/api/projects/${id}?confirm=${encodeURIComponent(o.confirm)}`, { method: 'DELETE' }); console.log(green('✓ Project deleted')); }));
for (const action of ['pause', 'resume']) {
  projects.command(`${action} <projectId>`).action(run(async (id) => { const r = await api(`/api/projects/${id}/${action}`, { method: 'POST' }); console.log(green(`✓ ${r.status}`)); }));
}

// ── database ────────────────────────────────────────────────────────────────
const db = program.command('db').description('Database: tables, SQL, schema');
db.command('tables <projectId>').action(run(async (id) => print((await api(`/api/projects/${id}/tables`)).data, ['name', 'row_count', 'size', 'rls_enabled', 'realtime_enabled'])));
db.command('table <projectId> <table>').action(run(async (id, t) => {
  const r = (await api(`/api/projects/${id}/tables/${t}`)).data;
  if (program.opts()['json']) return print(r);
  table(r.columns, ['name', 'type', 'nullable', 'default', 'is_primary_key']);
  console.log(dim(`\nRLS: ${r.rls_enabled ? 'on' : 'off'}  ·  realtime: ${r.realtime_enabled ? 'on' : 'off'}  ·  ${r.policies.length} policies`));
}));
db.command('exec <projectId>').description('Run SQL (from -q, -f or stdin)').option('-q, --query <sql>').option('-f, --file <path>')
  .action(run(async (id, o) => {
    const query = o.query ?? (o.file ? readFileSync(o.file, 'utf8') : await readStdin());
    if (!query.trim()) throw new Error('No SQL given. Use -q, -f or pipe it on stdin.');
    const r = await api(`/api/projects/${id}/execute`, { method: 'POST', json: { query } });
    if (program.opts()['json']) return print(r);
    if (r.columns?.length) table(r.data, r.columns);
    console.log(dim(`${r.command ?? 'OK'} · ${r.row_count} row(s) · ${r.duration_ms} ms${r.truncated ? ' · truncated' : ''}`));
  }));
db.command('explain <projectId>').requiredOption('-q, --query <sql>').option('--no-analyze')
  .action(run(async (id, o) => { const r = await api(`/api/projects/${id}/explain`, { method: 'POST', json: { query: o.query, analyze: o.analyze } }); program.opts()['json'] ? print(r) : console.log(r.plan); }));
db.command('dump <projectId>').description('Print the DDL of every table').action(run(async (id) => console.log((await api(`/api/projects/${id}/schema-dump`)).ddl)));
db.command('stats <projectId>').action(run(async (id) => {
  const s = (await api(`/api/projects/${id}/stats`)).data;
  if (program.opts()['json']) return print(s);
  print({ schema_size: s.size, connections: `${s.connections}/${s.max_connections}`, cache_hit_ratio: s.cache_hit_ratio, commits: s.transactions.commits, rollbacks: s.transactions.rollbacks });
  if (s.slow_queries.length) { console.log(bold('\nSlowest queries')); table(s.slow_queries, ['mean_ms', 'calls', 'query']); }
}));

// ── keys ────────────────────────────────────────────────────────────────────
const keys = program.command('keys').description('API keys');
keys.command('list <projectId>').action(run(async (id) => print((await api(`/api/keys?project_id=${id}`)).data, ['id', 'name', 'type', 'key_prefix', 'is_active', 'last_used_at'])));
keys.command('create <projectId>').requiredOption('--name <name>').option('--type <type>', 'anon | service_role | admin', 'anon').option('--expires <iso>')
  .action(run(async (id, o) => {
    const r = await api('/api/keys', { method: 'POST', json: { project_id: id, name: o.name, type: o.type, expires_at: o.expires } });
    if (program.opts()['json']) return print(r);
    console.log(green(`✓ ${r.type} key created`) + dim(` (${r.id})`));
    console.log(yellow('Store it now — it will not be shown again:'));
    console.log(r.key);
  }));
keys.command('revoke <keyId>').action(run(async (k) => { await api(`/api/keys/${k}`, { method: 'DELETE' }); console.log(green('✓ Key revoked')); }));
keys.command('rotate <keyId>').description('Replace a key; the old one keeps working for --grace seconds (0 = revoke now)')
  .option('--grace <seconds>', 'grace period for the old key', '3600')
  .action(run(async (k, o) => {
    const r = await api(`/api/keys/${k}/rotate`, { method: 'POST', json: { grace_period_seconds: Number(o.grace) } });
    if (program.opts()['json']) return print(r);
    console.log(green(`✓ ${r.type} key rotated`) + dim(` (new id ${r.id})`));
    console.log(r.previous_key.revoked ? dim('The old key was revoked.') : dim(`The old key works until ${r.previous_key.expires_at}.`));
    console.log(yellow('Store the new key now — it will not be shown again:'));
    console.log(r.key);
  }));
keys.command('rotate-all <projectId>').description('Rotate every active key of a project (e.g. after a leak)')
  .option('--grace <seconds>', 'grace period for the old keys', '0').option('--type <types>', 'comma-separated key types to rotate')
  .action(run(async (id, o) => {
    const r = await api('/api/keys/rotate', { method: 'POST', json: { project_id: id, grace_period_seconds: Number(o.grace), ...(o.type ? { types: String(o.type).split(',') } : {}) } });
    if (program.opts()['json']) return print(r);
    console.log(green(`✓ ${r.data.length} key(s) rotated`) + yellow(' — store the new keys now:'));
    for (const k of r.data) console.log(`  ${k.type.padEnd(13)} ${k.name.padEnd(20)} ${k.key}`);
  }));

// ── secrets ─────────────────────────────────────────────────────────────────
const secrets = program.command('secrets').description('Encrypted secrets (available to functions as env)');
secrets.command('list <projectId>').action(run(async (id) => print((await api(`/api/secrets?project_id=${id}`)).data, ['id', 'name', 'version', 'updated_at'])));
secrets.command('set <projectId> <name> [value]').description('value from argument or stdin')
  .action(run(async (id, name, value) => {
    const v = value ?? (await readStdin()).replace(/\n$/, '');
    if (!v) throw new Error('Provide a value as argument or on stdin');
    const r = await api('/api/secrets', { method: 'POST', json: { project_id: id, name, value: v } });
    console.log(green(`✓ ${r.name} saved (version ${r.version})`));
  }));
secrets.command('delete <secretId>').action(run(async (s) => { await api(`/api/secrets/${s}`, { method: 'DELETE' }); console.log(green('✓ Secret deleted')); }));

// ── storage ─────────────────────────────────────────────────────────────────
const storage = program.command('storage').description('Buckets and files');
storage.command('buckets <projectId>').action(run(async (id) => print(await request('storage', `/v1/${id}/bucket`), ['name', 'public', 'object_count', 'size_bytes', 'file_size_limit'])));
storage.command('create-bucket <projectId> <name>').option('--public').option('--max-size <bytes>').option('--mime <types>', 'comma-separated, e.g. image/*,application/pdf')
  .action(run(async (id, name, o) => {
    const r = await request('storage', `/v1/${id}/bucket`, { method: 'POST', json: { name, public: !!o.public, file_size_limit: o.maxSize ? Number(o.maxSize) : undefined, allowed_mime_types: o.mime ? o.mime.split(',') : undefined } });
    console.log(green(`✓ Bucket ${r.name} created`) + dim(r.public ? ' (public)' : ' (private)'));
  }));
storage.command('upload <projectId> <bucket> <file> [path]').option('--upsert')
  .action(run(async (id, bucket, file, path, o) => {
    const data = readFileSync(file);
    const form = new FormData();
    form.append('file', new Blob([data]), basename(file));
    const r = await request('storage', `/v1/${id}/object/${bucket}/${path ?? basename(file)}`, { method: 'POST', body: form, headers: o.upsert ? { 'x-upsert': 'true' } : {} });
    console.log(green(`✓ Uploaded ${r.Key}`) + (r.public_url ? dim(`\n  ${r.public_url}`) : ''));
  }));
storage.command('ls <projectId> <bucket> [prefix]').action(run(async (id, bucket, prefix) => {
  const r = await request('storage', `/v1/${id}/object/list/${bucket}`, { method: 'POST', json: { prefix: prefix ?? '' } });
  print(r.map((x: any) => ({ name: x.is_folder ? x.name + '/' : x.name, size: x.metadata?.size ?? '', type: x.metadata?.mimetype ?? 'folder', updated: x.updated_at ?? '' })), ['name', 'size', 'type', 'updated']);
}));

// ── functions ───────────────────────────────────────────────────────────────
const fns = program.command('functions').description('Serverless functions');
fns.command('list <projectId>').action(run(async (id) => print((await api(`/api/projects/${id}/functions`)).data, ['slug', 'version', 'verify_jwt', 'invocations_24h', 'errors_24h', 'updated_at'])));
fns.command('deploy <projectId> <slug> <file>').option('--no-verify-jwt', 'allow calls with only the anon key').option('--timeout <ms>', '', '5000')
  .action(run(async (id, slug, file, o) => {
    const r = await api(`/api/projects/${id}/functions`, { method: 'POST', json: { slug, code: readFileSync(file, 'utf8'), verify_jwt: o.verifyJwt, timeout_ms: Number(o.timeout) } });
    console.log(green(`✓ ${r.slug} deployed (version ${r.version})`));
  }));
fns.command('logs <projectId> <slug>').action(run(async (id, slug) => {
  const rows = (await api(`/api/projects/${id}/functions/${slug}/logs`)).data;
  if (program.opts()['json']) return print(rows);
  for (const l of rows.reverse()) console.log(`${dim(l.created_at)} v${l.version} ${l.status === 'success' ? green(l.status) : yellow(l.status)} ${l.status_code} ${l.duration_ms}ms${l.error ? ' ' + l.error.split('\n')[0] : ''}${l.logs ? '\n  ' + l.logs.replace(/\n/g, '\n  ') : ''}`);
}));
fns.command('invoke <projectId> <slug>').option('-d, --data <json>', 'JSON body').option('--apikey <key>', 'project API key (or ODB_API_KEY)')
  .action(run(async (id, slug, o) => {
    const key = o.apikey ?? process.env['ODB_API_KEY'];
    if (!key) {
      const r = await api(`/api/projects/${id}/functions/${slug}/invoke-async`, { method: 'POST', json: o.data ? JSON.parse(o.data) : {} });
      return console.log(green(`✓ Queued as job ${r.job_id}`) + dim(' (pass --apikey to invoke synchronously)'));
    }
    const out = await request('functions', `/v1/${id}/${slug}`, { method: 'POST', raw: true, headers: { apikey: key, authorization: `Bearer ${key}` }, json: o.data ? JSON.parse(o.data) : {} });
    console.log(out);
  }));

// ── backups ─────────────────────────────────────────────────────────────────
const backups = program.command('backups').description('Backups and restores');
backups.command('list <projectId>').action(run(async (id) => print((await api(`/api/backups?project_id=${id}`)).data, ['id', 'status', 'size_bytes', 'is_verified', 'created_at'])));
backups.command('create <projectId>').option('--wait', 'wait until finished')
  .action(run(async (id, o) => {
    const r = await api('/api/backups', { method: 'POST', json: { project_id: id } });
    console.log(green(`✓ Backup queued: ${r.id}`));
    if (!o.wait) return;
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await api(`/api/backups/${r.id}/status`);
      if (['completed', 'verified', 'failed'].includes(s.status)) { console.log(s.status === 'failed' ? yellow(`✗ ${s.error_message}`) : green(`✓ ${s.status}`)); return; }
    }
  }));
backups.command('restore <backupId>').option('--yes', 'skip confirmation')
  .action(run(async (bid, o) => {
    if (!o.yes && (await prompt(`Restore ${bid}? Current project data will be replaced. Type "restore": `)) !== 'restore') return console.log('Cancelled');
    const r = await api(`/api/backups/${bid}/restore`, { method: 'POST', json: { confirm: true } });
    console.log(green(`✓ Restore queued: ${r.restore_id}`));
  }));

// ── logs / users ────────────────────────────────────────────────────────────
program.command('logs <projectId>').option('--source <source>', 'all | audit | auth | functions | platform', 'all').option('-n, --limit <n>', '', '50')
  .action(run(async (id, o) => {
    const rows = (await api(`/api/projects/${id}/logs?source=${o.source}&limit=${o.limit}`)).data;
    if (program.opts()['json']) return print(rows);
    for (const l of rows.reverse()) console.log(`${dim(new Date(l.timestamp).toISOString())} ${l.level === 'info' ? '' : yellow(l.level + ' ')}[${l.source}] ${l.event}${l.actor ? dim(' · ' + l.actor) : ''}`);
  }));
program.command('users <projectId>').description('List end users of a project').option('--search <text>')
  .action(run(async (id, o) => print((await api(`/api/projects/${id}/users${o.search ? `?search=${encodeURIComponent(o.search)}` : ''}`)).data, ['id', 'email', 'email_verified', 'mfa_enabled', 'last_sign_in_at'])));

// ── access tokens (CI) ──────────────────────────────────────────────────────
const tokens = program.command('tokens').description('Personal access tokens for CI (use as ODB_TOKEN)');
tokens.command('list').action(run(async () => print((await api('/api/auth/tokens')).data, ['id', 'name', 'token_prefix', 'expires_at', 'last_used_at', 'revoked_at'])));
tokens.command('create <name>').option('--days <n>', 'expires after n days (1-365)', '90').option('--no-expiry', 'never expires')
  .action(run(async (name, o) => {
    const r = await api('/api/auth/tokens', { method: 'POST', json: { name, expires_in_days: o.expiry === false ? null : Number(o.days) } });
    if (program.opts()['json']) return print(r);
    console.log(green(`✓ Token created`) + dim(r.expires_at ? ` (expires ${r.expires_at})` : ' (no expiry)'));
    console.log(yellow('Store it now — it will not be shown again:'));
    console.log(r.token);
  }));
tokens.command('revoke <tokenId>').action(run(async (t) => { await api(`/api/auth/tokens/${t}`, { method: 'DELETE' }); console.log(green('✓ Token revoked')); }));

// ── branches ────────────────────────────────────────────────────────────────
const branches = program.command('branches').description('Preview / development copies of a project');
branches.command('list <projectId>').action(run(async (id) => print((await api(`/api/projects/${id}/branches`)).data, ['id', 'branch_name', 'status', 'unmerged_migrations', 'created_at'])));
branches.command('create <projectId> <name>').option('--with-data', 'copy the rows too')
  .action(run(async (id, name, o) => {
    const r = await api(`/api/projects/${id}/branches`, { method: 'POST', json: { name, with_data: !!o.withData } });
    if (program.opts()['json']) return print(r);
    console.log(green(`✓ Branch ${name} created`) + dim(` (project ${r.id})`));
    console.log(`  REST          ${r.endpoints.rest_url}\n  anon          ${r.api_keys.anon}\n  service_role  ${r.api_keys.service_role}`);
  }));
branches.command('merge <projectId> <branchId>').option('--dry-run', 'check the first pending migration only')
  .action(run(async (id, b, o) => {
    const r = await api(`/api/projects/${id}/branches/${b}/merge`, { method: 'POST', json: { dry_run: !!o.dryRun } });
    if (program.opts()['json']) return print(r);
    console.log(r.applied.length ? green(`✓ ${o.dryRun ? 'Checked' : 'Merged'} ${r.applied.join(', ')}`) : green('✓ Nothing to merge'));
  }));
branches.command('delete <projectId> <branchId>').action(run(async (id, b) => { await api(`/api/projects/${id}/branches/${b}`, { method: 'DELETE' }); console.log(green('✓ Branch deleted')); }));

registerMigrationCommands(program, run);

program.parseAsync().catch(fail);
