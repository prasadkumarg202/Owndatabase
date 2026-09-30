// The real @supabase/supabase-js against an OwnDatabase project (via tests/test_supabase_js.py,
// which prepares the project and sets ODB_URL, ODB_PROJECT_ID, ODB_ANON_KEY, ODB_SERVICE_KEY).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import * as tus from 'tus-js-client';

const { ODB_URL, ODB_PROJECT_ID, ODB_ANON_KEY, ODB_SERVICE_KEY } = process.env;
const skip = !ODB_URL || !ODB_PROJECT_ID;
const url = `${ODB_URL}/p/${ODB_PROJECT_ID}`;
const clients = [];
const client = (key, extra = {}) => {
  const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, ...extra });
  clients.push(c);
  return c;
};
after(async () => { for (const c of clients) await c.removeAllChannels(); });

const waitFor = (label, fn, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  fn((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

test('postgrest: select, filters, count, single, insert/update/delete, rpc', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const { data, error } = await db.from('compat_items').select('id,name').gte('price', 20).order('price', { ascending: false });
  assert.equal(error, null, JSON.stringify(error));
  assert.deepEqual(data.map((r) => r.name), ['gamma', 'beta']);
  const { count } = await db.from('compat_items').select('*', { count: 'exact', head: true });
  assert.equal(count, 3);
  assert.deepEqual((await db.from('compat_items').select('name').eq('id', 1).single()).data, { name: 'alpha' });

  const admin = client(ODB_SERVICE_KEY);
  const ins = await admin.from('compat_items').insert({ id: 9, name: 'nine', price: 9 }).select().single();
  assert.equal(ins.error, null, JSON.stringify(ins.error));
  assert.equal(ins.data.name, 'nine');
  const upd = await admin.from('compat_items').update({ price: 99 }).eq('id', 9).select('price');
  assert.equal(Number(upd.data[0].price), 99);
  assert.equal((await admin.from('compat_items').delete().eq('id', 9)).error, null);
  const rpc = await db.rpc('compat_add', { a: 2, b: 5 });
  assert.equal(rpc.data, 7, JSON.stringify(rpc.error));
});

test('auth: sign up, password sign-in, getUser, RLS, sign out', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const email = `compat-${Date.now()}@example.com`;
  const up = await db.auth.signUp({ email, password: 'password-123', options: { data: { plan: 'free' } } });
  assert.equal(up.error, null, JSON.stringify(up.error));
  assert.equal(up.data.user.email, email);
  const inn = await db.auth.signInWithPassword({ email, password: 'password-123' });
  assert.equal(inn.error, null, JSON.stringify(inn.error));
  const me = await db.auth.getUser();
  assert.equal(me.data.user.user_metadata.plan, 'free');
  const note = await db.from('compat_notes').insert({ body: 'mine' }).select('body,owner').single();
  assert.equal(note.error, null, JSON.stringify(note.error));
  assert.equal(note.data.owner, up.data.user.id);
  assert.deepEqual((await db.from('compat_notes').select('body')).data, [{ body: 'mine' }]);
  assert.equal((await db.auth.signOut()).error, null);
  assert.deepEqual((await db.from('compat_notes').select('body')).data, []);
  const bad = await db.auth.signInWithPassword({ email, password: 'wrong-pass' });
  assert.ok(bad.error);
});

test('storage: upload, download, public and signed URLs, list, remove', { skip }, async () => {
  const b = client(ODB_SERVICE_KEY).storage.from('compat');
  const up = await b.upload('dir/hello.txt', new Blob(['hello supabase-js'], { type: 'text/plain' }), { upsert: true });
  assert.equal(up.error, null, JSON.stringify(up.error));
  const dl = await b.download('dir/hello.txt');
  assert.equal(await dl.data.text(), 'hello supabase-js');
  assert.equal(await (await fetch(b.getPublicUrl('dir/hello.txt').data.publicUrl)).text(), 'hello supabase-js');
  const signed = await b.createSignedUrl('dir/hello.txt', 60);
  assert.equal(signed.error, null, JSON.stringify(signed.error));
  assert.equal(await (await fetch(signed.data.signedUrl)).text(), 'hello supabase-js');
  const list = await b.list('dir');
  assert.ok(list.data.some((f) => f.name === 'hello.txt'), JSON.stringify(list));
  assert.equal((await b.remove(['dir/hello.txt'])).error, null);
});

test('resumable upload with tus-js-client (Supabase docs example)', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const email = `tus-${Date.now()}@example.com`;
  assert.equal((await db.auth.signUp({ email, password: 'password-123' })).error, null);
  const { data: { session } } = await db.auth.signInWithPassword({ email, password: 'password-123' });
  const data = Buffer.alloc(7 * 1024 * 1024 + 11, 7);          // two 6 MB chunks
  await new Promise((resolve, reject) => {
    const upload = new tus.Upload(data, {
      endpoint: `${url}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000],
      headers: { authorization: `Bearer ${session.access_token}`, 'x-upsert': 'true' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: { bucketName: 'compat', objectName: `tus/${email}.bin`, contentType: 'application/octet-stream', cacheControl: '3600' },
      chunkSize: 6 * 1024 * 1024,
      onError: reject,
      onSuccess: resolve,
    });
    upload.start();
  });
  const dl = await client(ODB_SERVICE_KEY).storage.from('compat').download(`tus/${email}.bin`);
  assert.equal(dl.error, null, JSON.stringify(dl.error));
  assert.equal((await dl.data.arrayBuffer()).byteLength, data.length);
});

test('auth: signInAnonymously, then add an email', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const { data, error } = await db.auth.signInAnonymously({ options: { data: { theme: 'dark' } } });
  assert.equal(error, null, JSON.stringify(error));
  assert.equal(data.user.is_anonymous, true);
  assert.equal(data.user.user_metadata.theme, 'dark');
  const email = `anon-${Date.now()}@example.com`;
  const up = await db.auth.updateUser({ email });
  assert.equal(up.error, null, JSON.stringify(up.error));
  assert.equal(up.data.user.email, email);
  assert.equal(up.data.user.is_anonymous, false);
});

test('auth: signInWithSSO returns the identity provider URL', { skip: skip || !process.env.ODB_SSO_DOMAIN }, async () => {
  const { data, error } = await client(ODB_ANON_KEY).auth.signInWithSSO({
    domain: process.env.ODB_SSO_DOMAIN, options: { redirectTo: 'http://app.example.com/after', skipBrowserRedirect: true },
  });
  assert.equal(error, null, JSON.stringify(error));
  assert.ok(data.url.startsWith(process.env.ODB_SSO_URL) && data.url.includes('SAMLRequest='), data.url);
});

test('auth: MFA with an SMS code (enroll, challenge, verify)', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const email = `mfa-${Date.now()}@example.com`;
  await db.auth.signUp({ email, password: 'password-123' });
  await db.auth.signInWithPassword({ email, password: 'password-123' });
  const phone = `+9199${String(Date.now()).slice(-8)}`;
  const en = await db.auth.mfa.enroll({ factorType: 'phone', phone });
  assert.equal(en.error, null, JSON.stringify(en.error));
  const ch = await db.auth.mfa.challenge({ factorId: en.data.id });
  assert.equal(ch.error, null, JSON.stringify(ch.error));
  // the code from the auth service's dev mailbox (no real SMS in tests)
  const box = await (await fetch(`${ODB_URL}/auth/v1/${ODB_PROJECT_ID}/_dev/sms?phone=${encodeURIComponent(phone)}`, { headers: { apikey: ODB_ANON_KEY } })).json();
  const v = await db.auth.mfa.verify({ factorId: en.data.id, challengeId: ch.data.id, code: box.data[0].code });
  assert.equal(v.error, null, JSON.stringify(v.error));
  const aal = await db.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.equal(aal.data.currentLevel, 'aal2');
});

test('functions.invoke', { skip }, async () => {
  const r = await client(ODB_ANON_KEY).functions.invoke('compat-echo', { body: { n: 3 } });
  assert.equal(r.error, null, String(r.error));
  assert.deepEqual(r.data, { got: 3 });
});

for (const vsn of ['2.0.0', '1.0.0']) {
  test(`realtime (vsn ${vsn}): postgres_changes, broadcast, presence`, { skip }, async () => {
    const opts = { realtime: { vsn } };
    const db = client(ODB_SERVICE_KEY, opts);
    const writer = client(ODB_SERVICE_KEY);
    const id = vsn === '2.0.0' ? 101 : 102;

    const change = await waitFor('postgres change', (ok, fail) => {
      db.channel(`items-${vsn}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'compat_items', filter: `id=eq.${id}` }, (p) => ok(p))
        .subscribe(async (status, err) => {
          if (status === 'SUBSCRIBED') await writer.from('compat_items').insert({ id, name: `rt-${vsn}`, price: 1 });
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') fail(err ?? new Error(status));
        });
    });
    assert.equal(change.eventType, 'INSERT');
    assert.equal(change.table, 'compat_items');
    assert.equal(change.new.name, `rt-${vsn}`);
    assert.equal(change.new.id, id);

    const a = client(ODB_ANON_KEY, opts), b = client(ODB_ANON_KEY, opts);
    const room = `room-${vsn}`;
    const got = await waitFor('broadcast', (ok, fail) => {
      b.channel(room).on('broadcast', { event: 'ping' }, (m) => ok(m)).subscribe((s) => {
        if (s !== 'SUBSCRIBED') return;
        const ch = a.channel(room, { config: { broadcast: { ack: true } } });
        ch.subscribe(async (s2) => {
          if (s2 === 'SUBSCRIBED') {
            const r = await ch.send({ type: 'broadcast', event: 'ping', payload: { n: 1 } });
            if (r !== 'ok') fail(new Error(`send: ${r}`));
          }
        });
      });
    });
    assert.deepEqual(got.payload, { n: 1 });

    const synced = await waitFor('presence', (ok, fail) => {
      const ch = a.channel(`lobby-${vsn}`, { config: { presence: { key: 'user-a' } } });
      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState();
        if (state['user-a']?.[0]?.status === 'online') ok(state);
      }).subscribe(async (s) => {
        if (s === 'SUBSCRIBED') { const r = await ch.track({ status: 'online' }); if (r !== 'ok') fail(new Error(`track: ${r}`)); }
      });
    });
    assert.equal(synced['user-a'][0].status, 'online');
  });
}
