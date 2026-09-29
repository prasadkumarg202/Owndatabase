# Branches

A branch is a copy of a project's database for previews and development: a
separate project in the same organization with its **own schema, API keys, end
users and storage**, created from the parent's current schema.

```bash
odb branches create <projectId> feature-login [--with-data]   # prints the branch's URL and keys
odb db push <branchId>                                         # add migrations to the branch
odb branches merge <projectId> <branchId> [--dry-run]          # apply the branch's new migrations to the parent
odb branches list <projectId>
odb branches delete <projectId> <branchId>
```

Dashboard: Project → **Branches**. API: `/api/projects/:id/branches` (GET, POST
`{name, with_data}`), `…/:branchId/merge`, `DELETE …/:branchId`. Owners and
admins.

## What is copied

| | Copied |
|---|---|
| Schema (tables, views, functions, triggers, RLS policies, indexes) | yes |
| Rows | only with `--with-data` |
| Migration history | yes — the branch starts where the parent is |
| Auth settings, usage limits, functions | yes |
| Secrets | **no** (often production credentials) — set them on the branch |
| End users, storage files, webhooks, cron jobs, API keys | no (the branch gets its own keys) |

The schema is replayed and the rows loaded **as the branch's own database
role**, never as the platform superuser, so user-defined triggers and defaults
cannot run with elevated rights.

## Merging

`merge` applies, in order, the migrations recorded on the branch that the
parent does not have — each in its own transaction, stopping at the first
failure. `--dry-run` runs the first one on the parent and rolls it back. Data
is never merged. Branch from the main project only (no branches of branches).
Deleting a project deletes its branches.

## Preview branch per pull request

`odb init --github` also writes `.github/workflows/odb-preview-branches.yml`:
opening or updating a PR that changes `odb/migrations` creates `pr-<number>`
and pushes the migrations to it; merging the PR merges the branch into the main
project; closing the PR deletes it. Secrets: see [migrations.md](migrations.md).
