/**
 * Markdown shown at the top of /api/docs (OpenAPI info.description).
 * Swagger UI renders headings, lists, tables and fenced code blocks.
 */
export const DOCS_INTRO = `
AapStack gives every project a PostgreSQL database, authentication (password, email and phone OTP, OAuth),
an instant REST API, file storage, realtime and server functions. This page documents the **Control API**
used to manage projects; the sections below show how your *app* talks to a project.

---

## 1. Base URLs and keys

| What | URL |
|---|---|
| Control API (this page) | \`https://aapstack.tech/api\` |
| Project REST API | \`https://aapstack.tech/p/<project-id>/rest/v1\` |
| Project Auth | \`https://aapstack.tech/p/<project-id>/auth/v1\` |
| Project Storage | \`https://aapstack.tech/p/<project-id>/storage/v1\` |
| Project Functions | \`https://aapstack.tech/p/<project-id>/functions/v1\` |

The project URLs are compatible with **supabase-js**:

\`\`\`js
import { createClient } from '@supabase/supabase-js'
const app = createClient('https://aapstack.tech/p/<project-id>', '<anon-key>')
\`\`\`

**Keys.** Every project has an \`anon\` key (safe in browsers; Row Level Security applies) and a
\`service_role\` key (server only; bypasses RLS). Send them as \`apikey: <key>\` and
\`Authorization: Bearer <key>\`. After a user signs in, send their access token in \`Authorization\` instead.

**Calling this Control API.** Create a personal access token in the dashboard (*Access tokens*) and send
\`Authorization: Bearer odb_pat_...\`, then use **Authorize** on this page to try requests.

---

## 2. REST API (instant, from your tables)

Every table and view in your project becomes an endpoint. Filters use the PostgREST syntax.

\`\`\`bash
# 20 newest approved properties, selected columns only
curl "https://aapstack.tech/p/<project-id>/rest/v1/properties?select=id,title,price&status=eq.approved&order=created_at.desc&limit=20" \\
  -H "apikey: <anon-key>" -H "Authorization: Bearer <anon-key>"

# Insert a row and return it
curl -X POST "https://aapstack.tech/p/<project-id>/rest/v1/leads" \\
  -H "apikey: <anon-key>" -H "Authorization: Bearer <user-access-token>" \\
  -H "Content-Type: application/json" -H "Prefer: return=representation" \\
  -d '{"name":"Priya","phone":"+919876543210"}'

# Call a database function (RPC)
curl -X POST "https://aapstack.tech/p/<project-id>/rest/v1/rpc/search_locations" \\
  -H "apikey: <anon-key>" -H "Content-Type: application/json" \\
  -d '{"search_query":"Madhurawada","limit_count":5}'
\`\`\`

Operators: \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`like\`, \`ilike\`, \`in.(a,b)\`, \`is.null\`.
Pagination with \`limit\` / \`offset\` or a \`Range\` header; related tables with \`select=*,owner(name)\`.
A GraphQL endpoint is also available per project.

---

## 3. OTP sign-in (phone and email)

**Phone (SMS / WhatsApp).** Turn on phone sign-in in *Authentication → Settings* and choose an SMS
provider: the built-in **Twilio** connector, or a **webhook** for MSG91, Gupshup, AWS SNS, WhatsApp
or any gateway. Codes are 6 digits.

\`\`\`js
await app.auth.signInWithOtp({ phone: '+919876543210' })                          // sends the SMS
await app.auth.verifyOtp({ phone: '+919876543210', token: '730254', type: 'sms' })  // returns a session
\`\`\`

\`\`\`bash
curl -X POST "https://aapstack.tech/p/<project-id>/auth/v1/otp" -H "apikey: <anon-key>" \\
  -H "Content-Type: application/json" -d '{"phone":"+919876543210"}'
curl -X POST "https://aapstack.tech/p/<project-id>/auth/v1/verify" -H "apikey: <anon-key>" \\
  -H "Content-Type: application/json" -d '{"type":"sms","phone":"+919876543210","token":"730254"}'
\`\`\`

**Email (code or magic link).** \`POST /auth/v1/otp\` with \`{"email": "..."}\` emails a 6-digit code and a
sign-in link. Verify the code with \`type: "email"\` (what supabase-js sends) or \`type: "magiclink"\`:

\`\`\`bash
curl -X POST "https://aapstack.tech/p/<project-id>/auth/v1/verify" -H "apikey: <anon-key>" \\
  -H "Content-Type: application/json" -d '{"type":"email","email":"priya@gmail.com","token":"482913"}'
\`\`\`

Email is delivered over SMTP (Gmail with an app password, Zoho Mail, Resend or your own server).
Other verify types: \`signup\` (confirm email), \`recovery\` (password reset), \`phone_change\`.

Also available: email + password, Google, Apple, Microsoft, GitHub, LinkedIn, Facebook and more
OAuth providers, SAML SSO, TOTP two-factor and anonymous sign-in.

---

## 4. Database

Each project is a PostgreSQL 16 schema with its own owner role.

- **SQL** — \`POST /api/projects/{id}/execute\` with \`{"query": "...", "read_only": false}\` runs SQL as the
  project owner (one transaction per call). \`POST /api/projects/{id}/explain\` returns the query plan.
- **Tables** — create, alter and browse rows under \`/api/projects/{id}/tables\`.
- **Row Level Security** — list and create policies under \`/api/projects/{id}/policies\`; use
  \`auth.uid()\`, \`auth.jwt()\` and \`auth.role()\` in policies, and target \`anon\` / \`authenticated\`.
- **Extensions** — enable PostGIS, pgvector, pg_trgm, unaccent and more with
  \`POST /api/projects/{id}/extensions\` \`{"name":"postgis"}\`.
- **Migrations, backups, branches** — versioned migrations (\`odb db push\`), scheduled encrypted backups
  with test restores, and preview branches each have their own endpoints below.

\`\`\`bash
curl -X POST "https://aapstack.tech/api/projects/<project-id>/execute" \\
  -H "Authorization: Bearer odb_pat_..." -H "Content-Type: application/json" \\
  -d '{"query":"create table notes (id bigint generated always as identity primary key, body text, user_id uuid default auth.uid()); alter table notes enable row level security;"}'
\`\`\`

---

## 5. Functions (edge functions)

Server-side JavaScript that runs on **Node 22** (a \`(req) => response\` handler, not Deno), close to your
database. Use them for webhooks, payment callbacks, sending messages or anything that needs a secret.

\`\`\`js
// hello.js
export default async function (req) {
  const { name } = await req.json()
  // req.env holds project secrets and ODB_REST_URL / ODB_AUTH_URL / ODB_STORAGE_URL
  return { status: 200, body: { message: \`Hello \${name}\` } }
}
\`\`\`

\`\`\`bash
# Deploy (or use the dashboard / odb CLI)
curl -X POST "https://aapstack.tech/api/projects/<project-id>/functions" \\
  -H "Authorization: Bearer odb_pat_..." -H "Content-Type: application/json" \\
  -d '{"slug":"hello","code":"export default async (req) => ({ status: 200, body: { ok: true } })","timeout_ms":5000,"memory_mb":128}'

# Invoke
curl -X POST "https://aapstack.tech/p/<project-id>/functions/v1/hello" \\
  -H "Authorization: Bearer <anon-key>" -H "Content-Type: application/json" -d '{"name":"Vizag"}'
\`\`\`

\`supabase.functions.invoke('hello', { body: { name: 'Vizag' } })\` works too. Functions can also run in
the background (\`/invoke-async\`), on a **cron** schedule, or from **queues** with retries, and
**database webhooks** can call them on insert, update or delete. Limits: up to 60 s and 1 GB memory per
invocation.

---

## 6. Storage and realtime

- **Storage** — buckets (public or private), uploads, signed URLs and image resizing at
  \`/storage/v1\`; files can live on S3, Cloudflare R2, Backblaze, MinIO or local disk.
- **Realtime** — subscribe to inserts, updates and deletes, broadcast and presence with
  \`supabase.channel()\`. Enable realtime per table first.

---

## 7. Command line and AI tools

- **odb CLI** — \`odb login --token odb_pat_...\`, then manage projects, run migrations and deploy functions.
- **MCP server** — lets AI assistants (Claude, Cursor and others) inspect and manage your projects.

Questions or problems: open an issue at https://github.com/prasadkumarg202/Owndatabase
`;
