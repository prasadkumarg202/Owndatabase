/**
 * Project provisioning.
 *
 * Every project gets:
 *   - its own PostgreSQL schema (project_<slug>)
 *   - an owner LOGIN role that owns that schema and everything in it
 *   - USAGE + default privileges for anon / authenticated / service_role,
 *     so the REST API can run queries under those roles and RLS applies
 *
 * All statements are idempotent, so provisioning can be re-run safely.
 */
import { createHash, randomBytes } from 'node:crypto';

export function generateDbPassword(): string {
  return randomBytes(24).toString('base64url');
}
import { db, ident, literal } from './db.js';
import { ownerRole } from './access.js';

export async function provisionProjectSchema(schema: string, password: string): Promise<void> {
  const owner = ownerRole(schema);
  const s = ident(schema);
  const o = ident(owner);
  await db.begin(async (sql) => {
    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${owner.replace(/'/g, "''")}') THEN
          CREATE ROLE ${o} NOINHERIT;
        END IF;
      END $$;
    `);
    // The owner is a LOGIN role: the SQL editor connects *as* this role, so
    // RESET ROLE / SET ROLE tricks cannot escalate to another project.
    await sql.unsafe(`ALTER ROLE ${o} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(password)}`);
    await sql.unsafe(`ALTER ROLE ${o} SET search_path = ${s}, public, extensions`);
    await sql.unsafe(`ALTER ROLE ${o} SET statement_timeout = '30s'`);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${s} AUTHORIZATION ${o}`);
    await sql.unsafe(`ALTER SCHEMA ${s} OWNER TO ${o}`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA ${s} TO anon, authenticated, service_role`);
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${s} TO anon, authenticated, service_role`);
    await sql.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${s} TO anon, authenticated, service_role`);
    await sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO anon, authenticated, service_role`);
    for (const kind of ['TABLES', 'SEQUENCES']) {
      await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT ALL ON ${kind} TO anon, authenticated, service_role`);
    }
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`);
    // Let project tables reference auth.users and use auth.uid() in policies
    await sql.unsafe(`GRANT USAGE ON SCHEMA auth TO ${o}`);
    await sql.unsafe(`GRANT REFERENCES ON auth.users TO ${o}`);
    await sql.unsafe(`GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email() TO ${o}`);
    // Project owners must not be able to read other projects or the control plane
    await sql.unsafe(`REVOKE ALL ON SCHEMA control_plane FROM ${o}`);
    await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  });
}

export async function dropProjectSchema(schema: string): Promise<void> {
  const owner = ownerRole(schema);
  await db.begin(async (sql) => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
    await sql.unsafe(`
      DO $$ BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${owner.replace(/'/g, "''")}') THEN
          EXECUTE 'REASSIGN OWNED BY ${ident(owner).replace(/'/g, "''")} TO CURRENT_USER';
          EXECUTE 'DROP OWNED BY ${ident(owner).replace(/'/g, "''")}';
          EXECUTE 'DROP ROLE ${ident(owner).replace(/'/g, "''")}';
        END IF;
      END $$;
    `);
  });
}

export const KEY_PREFIXES: Record<string, string> = {
  anon: 'odb_anon_',
  authenticated: 'odb_auth_',
  service_role: 'odb_svc_',
  admin: 'odb_admin_',
};

export function generateApiKey(type: string): { key: string; hash: string; prefix: string } {
  const key = `${KEY_PREFIXES[type] ?? 'odb_'}${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 16) };
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
