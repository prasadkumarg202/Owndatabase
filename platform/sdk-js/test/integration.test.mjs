// Integration test against a running stack. Run through tests/test_sdk_js.py, which
// creates the project and sets ODB_URL, ODB_PROJECT_ID, ODB_ANON_KEY, ODB_SERVICE_KEY.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../dist/index.js';

const { ODB_URL, ODB_PROJECT_ID, ODB_ANON_KEY, ODB_SERVICE_KEY } = process.env;
const skip = !ODB_URL || !ODB_PROJECT_ID;
const opts = { projectId: ODB_PROJECT_ID, auth: { persistSession: false } };
const clients = [];
const client = (key) => { const c = createClient(ODB_URL, key, opts); clients.push(c); return c; };
after(() => { for (const c of clients) { c.auth.stopAutoRefresh(); c.removeAllChannels(); } });

test('query builder: select, filters, order, range, count, single', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const { data, error } = await db.from('sdk_items').select('id,name,price').gte('price', 20).order('price', { ascending: false });
  assert.equal(error, null);
  assert.deepEqual(data.map((r) => r.name), ['gamma', 'beta']);

  const counted = await db.from('sdk_items').select('id', { count: 'exact' }).range(0, 0);
  assert.equal(counted.count, 3);
  assert.equal(counted.data.length, 1);

  const one = await db.from('sdk_items').select('name').eq('id', 1).single();
  assert.deepEqual(one.data, { name: 'alpha' });
  const none = await db.from('sdk_items').select('name').eq('id', 999).maybeSingle();
  assert.equal(none.data, null); assert.equal(none.error, null);
  const bad = await db.from('sdk_items').select('name').single();
  assert.equal(bad.error.status, 406);

  const inList = await db.from('sdk_items').select('id').in('name', ['alpha', 'gamma']).order('id');
  assert.deepEqual(inList.data, [{ id: 1 }, { id: 3 }]);
  const missing = await db.from('nope').select();
  assert.ok(missing.error && missing.error.status >= 400);
});

test('auth + RLS: sign up, insert own rows, refresh, sign out', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const events = [];
  db.auth.onAuthStateChange((e) => events.push(e));
  const email = `sdk-${Date.now()}@example.com`;
  const up = await db.auth.signUp({ email, password: 'password-123', options: { data: { name: 'SDK' } } });
  assert.equal(up.error, null);
  assert.equal(up.data.user.email, email);

  const me = await db.auth.getUser();
  assert.equal(me.data.user.user_metadata.name, 'SDK');

  const ins = await db.from('sdk_notes').insert({ body: 'mine' }).select('body,user_id').single();
  assert.equal(ins.error, null, JSON.stringify(ins.error));
  assert.equal(ins.data.user_id, up.data.user.id);
  const mine = await db.from('sdk_notes').select('body');
  assert.deepEqual(mine.data, [{ body: 'mine' }]);

  const ref = await db.auth.refreshSession();
  assert.equal(ref.error, null);
  // refresh tokens rotate (an access token issued in the same second can be identical)
  assert.notEqual(ref.data.session.refresh_token, up.data.session.refresh_token);

  await db.auth.signOut();
  assert.equal((await db.auth.getSession()).data.session, null);
  const anonView = await db.from('sdk_notes').select('body');
  assert.deepEqual(anonView.data, []);
  assert.ok(events.includes('SIGNED_IN') && events.includes('TOKEN_REFRESHED') && events.includes('SIGNED_OUT'), events.join());

  const wrong = await db.auth.signInWithPassword({ email, password: 'nope-nope' });
  assert.equal(wrong.error.status, 401);
  const ok = await db.auth.signInWithPassword({ email, password: 'password-123' });
  assert.equal(ok.error, null);
});

test('update, upsert, delete, rpc', { skip }, async () => {
  const db = client(ODB_SERVICE_KEY);
  const up = await db.from('sdk_items').update({ price: 11 }).eq('id', 1).select();
  assert.equal(up.data[0].price, 11);
  const ups = await db.from('sdk_items').upsert({ id: 4, name: 'delta', price: 40 }).select('name');
  assert.deepEqual(ups.data, [{ name: 'delta' }]);
  const del = await db.from('sdk_items').delete().eq('id', 4).select('id');
  assert.deepEqual(del.data, [{ id: 4 }]);
  const sum = await db.rpc('sdk_add', { a: 2, b: 3 });
  assert.equal(sum.data, 5);
});

test('storage: upload, list, download, public URL, signed URL, remove', { skip }, async () => {
  const db = client(ODB_SERVICE_KEY);
  const b = db.storage.from('sdk-files');
  const up = await b.upload('docs/hello.txt', 'hello sdk', { contentType: 'text/plain' });
  assert.equal(up.error, null, JSON.stringify(up.error));
  const list = await b.list('docs');
  assert.ok(list.data.some((f) => f.name.endsWith('hello.txt')), JSON.stringify(list.data));
  const dl = await b.download('docs/hello.txt');
  assert.equal(await dl.data.text(), 'hello sdk');
  const pub = await fetch(b.getPublicUrl('docs/hello.txt').data.publicUrl);
  assert.equal(await pub.text(), 'hello sdk');
  const signed = await b.createSignedUrl('docs/hello.txt', 60);
  assert.equal(signed.error, null);
  assert.equal(await (await fetch(signed.data.signedUrl)).text(), 'hello sdk');
  const rm = await b.remove(['docs/hello.txt']);
  assert.equal(rm.error, null);
  assert.equal((await b.download('docs/hello.txt')).error.status, 404);
});

test('functions.invoke', { skip }, async () => {
  const db = client(ODB_ANON_KEY);
  const r = await db.functions.invoke('sdk-echo', { body: { n: 7 } });
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.deepEqual(r.data, { got: 7 });
});

test('realtime: postgres changes and broadcast', { skip }, async () => {
  const db = client(ODB_SERVICE_KEY);
  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no change event')), 15000);
    db.channel('items').on('postgres_changes', { event: 'INSERT', table: 'sdk_items' }, (m) => { clearTimeout(t); resolve(m); })
      .subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') await createClient(ODB_URL, ODB_SERVICE_KEY, opts).from('sdk_items').insert({ id: 50, name: 'live', price: 1 });
        else if (status === 'CHANNEL_ERROR') reject(err);
      });
  });
  const change = await got;
  assert.equal(change.eventType, 'INSERT');
  assert.equal(change.new.name, 'live');

  const a = client(ODB_ANON_KEY), b = client(ODB_ANON_KEY);
  const heard = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no broadcast')), 15000);
    b.channel('room').on('broadcast', { event: 'hi' }, (m) => { clearTimeout(t); resolve(m); }).subscribe((s) => {
      if (s === 'SUBSCRIBED') { const ch = a.channel('room').on('broadcast', {}, () => {}).subscribe((s2) => { if (s2 === 'SUBSCRIBED') ch.send({ type: 'broadcast', event: 'hi', payload: { x: 1 } }); }); }
    });
  });
  assert.deepEqual((await heard).payload, { x: 1 });
});

test('graphql', { skip }, async () => {
  const db = client(ODB_SERVICE_KEY);
  const r = await db.graphql('query($n: Int) { sdk_items(orderBy: [{ id: ASC }], limit: $n) { id name } }', { n: 2 });
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.deepEqual(r.data.sdk_items.map((x) => x.id), [1, 2]);
  const bad = await db.graphql('{ sdk_items { nope } }');
  assert.ok(bad.error && /nope/.test(bad.error.message));
});
