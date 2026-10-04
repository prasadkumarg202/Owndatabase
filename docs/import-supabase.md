# Moving a Supabase project to OwnDatabase

Supabase dumps (`supabase db dump` → `roles.sql`, `schema.sql`, `data.sql`) are dumps of a whole
Supabase database. They create Supabase's roles and internal schemas, so they can't be restored into
a project as they are. `scripts/import-supabase.py` takes out the app's own part.

1. **Create the project** in the dashboard and note its ID. Its schema is `project_<slug>` (for
   example `project_ev2ev`).
2. **Enable the extensions** the app uses (dashboard → Database → Extensions, e.g. `postgis`,
   `pg_trgm`). Extensions live in `public`; references to `extensions.` are rewritten.
3. **Convert** the dump:

   ```bash
   python scripts/import-supabase.py --schema schema.sql --data data.sql \
       --target-schema project_ev2ev --project-id <project id> --out out/
   cat out/report.txt
   ```

4. **Apply** on the server, each file in a transaction. The schema runs as the project's owner role,
   so it can only create objects in that project:

   ```bash
   PSQL="docker exec -i -e PGPASSWORD=$POSTGRES_PASSWORD owndatabase-postgres psql -h 127.0.0.1 -U postgres -d owndatabase -v ON_ERROR_STOP=1"
   { echo "BEGIN; SET LOCAL ROLE \"project_ev2ev_owner\";"; cat out/1_schema.sql; echo "COMMIT;"; } | $PSQL
   { echo "BEGIN;"; cat out/2_data.sql; echo "COMMIT;"; } | $PSQL
   { echo "BEGIN;"; cat out/3_auth_triggers.sql; echo "COMMIT;"; } | $PSQL
   ```

## What carries over

| From Supabase | Result |
|---|---|
| `public` tables, types, functions, indexes, constraints, triggers, RLS policies, grants to `anon` / `authenticated` / `service_role` | In the project schema |
| Rows of `public` tables | Loaded, with sequences set |
| Triggers on `auth.users` (e.g. `on_auth_user_created` → `handle_new_user`) | Re-created on the shared `auth.users`, firing only for this project's users |
| Functions that read `auth.users` | Work: a project's code reads its own project's users (row-level security; migration 030) |

## What doesn't carry over

- **Users** (`auth.users`) aren't converted yet: Supabase stores bcrypt password hashes. Users can
  sign up again or reset their password.
- **Storage files**: the dump has only file metadata. Copy the files with the Storage API.
- **Unsupported Supabase extensions**: `http`, `pg_net` and `supabase_vault` aren't available, so
  functions calling them fail when called.
- **Roles, `realtime`, `vault`, `graphql`, publications and event triggers** are Supabase internals
  and are left out.
