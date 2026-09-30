# @owndatabase/client

TypeScript / JavaScript client for OwnDatabase: database (REST), auth, storage,
functions and realtime. No dependencies; works in browsers, Node 18+ (Node 22+
for realtime without a `WebSocket` polyfill), Deno and Bun. The API mirrors
supabase-js where the platforms match.

```ts
import { createClient } from '@owndatabase/client';

// platform URL + project id
const db = createClient('https://db.example.com', ANON_KEY, { projectId: 'b6f1…' });
// or a custom domain (no project id)
const db = createClient('https://api.myapp.com', ANON_KEY);
```

## Database

```ts
const { data, error, count } = await db
  .from('orders')
  .select('id,total,customer:customers(name)', { count: 'exact' })
  .eq('status', 'paid').gte('total', 100).in('region', ['south', 'west'])
  .order('created_at', { ascending: false })
  .range(0, 19);

await db.from('orders').insert({ total: 10 }).select().single();
await db.from('orders').upsert({ id: 1, total: 12 }, { onConflict: 'id' });
await db.from('orders').update({ status: 'shipped' }).eq('id', 1);
await db.from('orders').delete().eq('id', 1);
await db.rpc('order_totals', { since: '2026-01-01' });
```

Filters: `eq neq gt gte lt lte like ilike is in contains not or match filter`;
modifiers: `order limit range single maybeSingle`. Every call resolves to
`{ data, error, status, count? }` and never throws for HTTP errors.

## Auth

```ts
await db.auth.signUp({ email, password, options: { data: { name } } });
await db.auth.signInWithPassword({ email, password });           // or { phone, password }
await db.auth.signInWithOtp({ phone: '+919876543210' });
await db.auth.verifyOtp({ phone: '+919876543210', token: '123456', type: 'sms' });
const { data: { user } } = await db.auth.getUser();
await db.auth.updateUser({ data: { plan: 'pro' } });
db.auth.onAuthStateChange((event, session) => …);                // SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT, …
await db.auth.signOut();
```

Sessions persist in `localStorage` in browsers (memory elsewhere; set
`auth.storage` for another store) and refresh automatically. The access token
is sent with every database, storage, function and realtime request, so Row
Level Security applies to the signed-in user.

## Storage

```ts
const files = db.storage.from('avatars');
await files.upload('u1/me.png', file, { upsert: true });
await files.download('u1/me.png');                // Blob
files.getPublicUrl('u1/me.png', { transform: { width: 128, format: 'webp' } });
await files.createSignedUrl('u1/me.png', 3600);
await files.list('u1');
await files.remove(['u1/me.png']);
```

## Functions

```ts
const { data } = await db.functions.invoke('send-invoice', { body: { id: 1 } });
```

## Realtime

```ts
const ch = db.channel('orders')
  .on('postgres_changes', { event: 'INSERT', table: 'orders', filter: 'status=eq.paid' }, (m) => console.log(m.new))
  .on('broadcast', { event: 'typing' }, (m) => …)
  .on('presence', { event: 'sync' }, (m) => …)
  .subscribe((status) => …);            // SUBSCRIBED | CHANNEL_ERROR | CLOSED
ch.send({ type: 'broadcast', event: 'typing', payload: { user: 'a' } });
ch.track({ online_at: Date.now() });
db.removeChannel(ch);
```

Database changes need realtime enabled on the table (dashboard → Tables) and
are filtered by RLS for the subscriber. On Node < 22 pass
`{ realtime: { WebSocket } }` from the `ws` package.

## Development

`npm run build`; `npm test` runs the integration tests against a stack
(`tests/test_sdk_js.py` prepares a project and runs them).
