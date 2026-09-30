# Using supabase-js with OwnDatabase

Existing Supabase apps can keep using `@supabase/supabase-js` — only the URL and
keys change:

```js
import { createClient } from '@supabase/supabase-js';

// platform URL + /p/<projectId>
const supabase = createClient('https://db.example.com/p/<projectId>', ANON_KEY);
// or a custom domain (docs/custom-domains.md)
const supabase = createClient('https://api.myapp.com', ANON_KEY);
```

The gateway maps `/p/<projectId>/{rest,auth,storage,functions,graphql}/v1/…`
and `/p/<projectId>/realtime/v1/websocket` onto the project, exactly as a
custom domain does.

## What works

Checked by `tests/test_supabase_js.py`, which runs the real supabase-js
(2.117) against a project:

| Client | Covered |
|---|---|
| `supabase.from()` (postgrest-js) | select with filters / order / count / `head` / `single`, insert / update / delete with `.select()`, `rpc()` |
| `supabase.auth` | `signUp`, `signInWithPassword`, `getUser`, `signOut`, RLS as the signed-in user plus `signInWithOAuth` (implicit and PKCE), `signInWithIdToken`, OTP, phone and MFA (docs/oauth.md) |
| `supabase.storage` | `upload`, `download`, `getPublicUrl`, `createSignedUrl`, `list`, `remove` |
| `supabase.functions.invoke()` | |
| `supabase.channel()` | `postgres_changes` (with `filter`), `broadcast` (incl. `ack` and `self`), `presence` (`track`, `sync` / `join` / `leave`); realtime protocol 1.0.0 and 2.0.0 (the default), token refresh |

## Differences to know

- Use `schema: 'public'` in `postgres_changes` (it means the project's schema).
  Enable realtime on each table first (dashboard → Tables).
- Binary broadcast payloads (`ArrayBuffer`) are not supported; JSON payloads are.
- Realtime "authorization" (RLS on `realtime.messages`) is not implemented:
  channels named `private-…` or joined with `config: { private: true }` just
  require a signed-in user.
- Functions run on Node (a `(req) => response` handler), not Deno: Supabase Edge
  Function code needs porting (docs/functions.md).
- There is no Supabase management API, so the `supabase` CLI's project commands
  don't apply; use the `odb` CLI and migrations (docs/migrations.md).
