// The official Supabase Dart client (the core of supabase_flutter) against an OwnDatabase project.
// Run by tests/test_sdk_dart.py, which prepares the project and sets ODB_URL, ODB_ANON_KEY, ODB_SERVICE_KEY.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:supabase/supabase.dart';

final env = Platform.environment;
final url = env['ODB_URL']!;            // http://<host>/p/<projectId>
final anon = env['ODB_ANON_KEY']!;
// a bare SupabaseClient has no storage for PKCE code verifiers (supabase_flutter provides one): use the implicit flow
const implicit = AuthClientOptions(authFlowType: AuthFlowType.implicit);
final service = env['ODB_SERVICE_KEY']!;
var failures = 0;

Future<void> check(String name, Future<void> Function() body) async {
  try {
    await body().timeout(const Duration(seconds: 30));
    print('ok   $name');
  } catch (e, st) {
    failures++;
    print('FAIL $name: $e\n$st');
  }
}

void expect(bool cond, String what) {
  if (!cond) throw StateError(what);
}

Future<void> main() async {
  final db = SupabaseClient(url, anon, authOptions: implicit);
  final admin = SupabaseClient(url, service);

  await check('postgrest: select, filters, count, single, insert/update/delete, rpc', () async {
    final rows = await db.from('dart_items').select('id,name').gte('price', 20).order('price', ascending: false);
    expect(rows.map((r) => r['name']).join(',') == 'gamma,beta', 'filter/order: $rows');
    final counted = await db.from('dart_items').select('id').count(CountOption.exact);
    expect(counted.count == 3, 'count ${counted.count}');
    final one = await db.from('dart_items').select('name').eq('id', 1).single();
    expect(one['name'] == 'alpha', 'single $one');
    final ins = await admin.from('dart_items').insert({'id': 9, 'name': 'nine', 'price': 9}).select().single();
    expect(ins['name'] == 'nine', 'insert $ins');
    final upd = await admin.from('dart_items').update({'price': 99}).eq('id', 9).select('price');
    expect(num.parse('${upd.first['price']}') == 99, 'update $upd');
    await admin.from('dart_items').delete().eq('id', 9);
    final sum = await db.rpc('dart_add', params: {'a': 2, 'b': 5});
    expect(sum == 7, 'rpc $sum');
  });

  await check('auth: sign up, sign in, getUser, RLS, sign out', () async {
    final email = 'dart-${DateTime.now().millisecondsSinceEpoch}@example.com';
    final up = await db.auth.signUp(email: email, password: 'password-123', data: {'plan': 'free'});
    expect(up.user?.email == email, 'signUp ${up.user}');
    final s = await db.auth.signInWithPassword(email: email, password: 'password-123');
    expect(s.session?.accessToken.isNotEmpty == true, 'no session');
    final me = await db.auth.getUser();
    expect(me.user?.userMetadata?['plan'] == 'free', 'metadata ${me.user?.userMetadata}');
    final note = await db.from('dart_notes').insert({'body': 'mine'}).select('body,owner').single();
    expect(note['owner'] == up.user!.id, 'owner $note');
    final mine = await db.from('dart_notes').select('body');
    expect(mine.length == 1 && mine.first['body'] == 'mine', 'rls $mine');
    await db.auth.signOut();
    final none = await db.from('dart_notes').select('body');
    expect(none.isEmpty, 'after sign out $none');
  });

  await check('storage: upload, download, public / signed URL, list, remove', () async {
    final b = admin.storage.from('dart');
    await b.uploadBinary('dir/hello.txt', Uint8List.fromList(utf8.encode('hello dart')),
        fileOptions: const FileOptions(contentType: 'text/plain', upsert: true));
    final data = await b.download('dir/hello.txt');
    expect(utf8.decode(data) == 'hello dart', 'download');
    final pub = await HttpClient().getUrl(Uri.parse(b.getPublicUrl('dir/hello.txt'))).then((r) => r.close());
    expect(await pub.transform(utf8.decoder).join() == 'hello dart', 'public url');
    final signed = await b.createSignedUrl('dir/hello.txt', 60);
    final sres = await HttpClient().getUrl(Uri.parse(signed)).then((r) => r.close());
    expect(await sres.transform(utf8.decoder).join() == 'hello dart', 'signed url $signed');
    final list = await b.list(path: 'dir');
    expect(list.any((f) => f.name == 'hello.txt'), 'list');
    await b.remove(['dir/hello.txt']);
  });

  await check('functions.invoke', () async {
    final r = await db.functions.invoke('dart-echo', body: {'n': 3});
    final d = r.data is String ? jsonDecode(r.data as String) : r.data;
    expect(d['got'] == 3, 'invoke ${r.data}');
  });

  await check('realtime: postgres_changes and broadcast', () async {
    final rt = SupabaseClient(url, service);
    final change = Completer<PostgresChangePayload>();
    final subscribed = Completer<void>();
    rt.channel('dart-items').onPostgresChanges(event: PostgresChangeEvent.insert, schema: 'public', table: 'dart_items',
        callback: (p) { if (!change.isCompleted) change.complete(p); }).subscribe((status, [err]) {
      if (status == RealtimeSubscribeStatus.subscribed && !subscribed.isCompleted) subscribed.complete();
    });
    await subscribed.future;
    await admin.from('dart_items').insert({'id': 77, 'name': 'rt-dart', 'price': 1});
    final p = await change.future;
    expect(p.newRecord['name'] == 'rt-dart', 'record ${p.newRecord}');

    final got = Completer<Map<String, dynamic>>();
    final a = SupabaseClient(url, anon), b = SupabaseClient(url, anon);
    final ready = Completer<void>();
    b.channel('dart-room').onBroadcast(event: 'ping', callback: (m) { if (!got.isCompleted) got.complete(m); }).subscribe((s, [e]) {
      if (s == RealtimeSubscribeStatus.subscribed && !ready.isCompleted) ready.complete();
    });
    await ready.future;
    final sender = a.channel('dart-room');
    final senderReady = Completer<void>();
    sender.subscribe((s, [e]) { if (s == RealtimeSubscribeStatus.subscribed && !senderReady.isCompleted) senderReady.complete(); });
    await senderReady.future;
    await sender.sendBroadcastMessage(event: 'ping', payload: {'n': 1});
    final m = await got.future;
    expect(m['n'] == 1 || (m['payload'] is Map && m['payload']['n'] == 1), 'broadcast $m');
    await rt.removeAllChannels();
    await a.removeAllChannels();
    await b.removeAllChannels();
  });

  print(failures == 0 ? 'ALL PASSED' : '$failures FAILED');
  exit(failures == 0 ? 0 : 1);
}
