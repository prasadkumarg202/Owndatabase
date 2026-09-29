# Migrations and CI

Keep your project's schema in your application repository as SQL migrations and
apply them with the `odb` CLI, locally or from GitHub Actions.

```bash
odb login                                   # once, interactive
odb init --github                           # odb/migrations, odb/seed.sql, .github/workflows/odb-migrations.yml
odb migration new "create orders"           # odb/migrations/20260929153000_create_orders.sql
# … write SQL …
odb db push <projectId> --dry-run           # run the next pending migration and roll it back
odb db push <projectId>                     # apply every pending migration, in order
odb migration list <projectId>              # local vs applied
```

## How a migration runs

- Each migration runs in **one transaction** on the project's own owner-role
  connection (the same one the SQL editor uses, never the platform superuser),
  with `search_path` = the project schema, a 10-minute statement timeout and a
  15 s lock timeout.
- It is recorded in the same transaction, so it is either applied and
  recorded, or neither. A failure reports the position and hint; later
  migrations are not attempted.
- `BEGIN`/`COMMIT`/`SAVEPOINT` and `CREATE INDEX CONCURRENTLY` are refused
  (they cannot run inside the migration's transaction).
- Versions are the digits before `_` in the file name. An applied migration
  cannot be changed: its checksum is stored, and `db push` stops if the local
  file differs. Line endings do not matter (files are sent with `\n`).
- Write migrations without a schema name (`create table orders …`), so they
  apply to any project.

## Adopting an existing project

```bash
odb db pull <projectId>          # current schema → odb/migrations/<ts>_remote_schema.sql, recorded as applied
```

Commit that file; from then on add migrations on top of it.

## Reset (development)

```bash
odb db reset <projectId> --confirm <project-slug>
```

Drops every table, view, function and type in the project schema, re-applies
all local migrations and then runs `odb/seed.sql`. End users (auth) and
storage files are kept. Owner or admin only.

## Repair

`odb migration repair <projectId> <version> --status applied|reverted` marks a
version as applied (without running it) or removes its record (without undoing
anything) — for migrations applied by hand or rolled back manually.

## GitHub Actions

`odb init --github` writes `.github/workflows/odb-migrations.yml`: pull requests
dry-run the next migration, pushes to `main` apply them. Add repository secrets:

| Secret | Value |
|---|---|
| `ODB_URL` | your platform URL, e.g. `https://db.example.com` |
| `ODB_TOKEN` | a personal access token: `odb tokens create github-ci --days 365` |
| `ODB_PROJECT_ID` | the project to migrate |
| `ODB_CLI_REPO_TOKEN` | only if the OwnDatabase repository is private: a read token for it |

The workflow builds the CLI from the OwnDatabase repository (set the
`ODB_CLI_REPO` variable if you use a fork).

## Personal access tokens

`odb tokens create <name> [--days n | --no-expiry]`, `odb tokens list`,
`odb tokens revoke <id>` (API: `/api/auth/tokens`). A token acts as your user —
same organizations and roles — and is sent as `Authorization: Bearer odb_pat_…`
(`ODB_TOKEN` for the CLI). Creating a token needs a signed-in session, so a
leaked token cannot mint more; only the SHA-256 of a token is stored.

## API

| Call | |
|---|---|
| `GET /api/projects/:id/migrations` | applied migrations |
| `POST /api/projects/:id/migrations` `{version, name, sql, dry_run?}` | apply (developers and up) |
| `POST /api/projects/:id/migrations/repair` `{version, status, name?, sql?}` | owners / admins |
| `GET /api/projects/:id/migrations/remote-schema` | schema DDL (pg_dump) as a migration |
| `POST /api/projects/:id/database/reset` `{confirm: slug}` | owners / admins |
