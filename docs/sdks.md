# Client SDKs

OwnDatabase speaks Supabase's APIs, so the **official Supabase client libraries** work unchanged.
Point them at the project URL, `https://<your host>/p/<projectId>` (or a custom domain), and use the
project's anon or service key.

| Language | Package | Tested by |
|---|---|---|
| JavaScript / TypeScript | `@supabase/supabase-js` | `tests/test_supabase_js.py` ([supabase-js.md](supabase-js.md)) |
| Python | `supabase` (supabase-py) | `tests/test_sdk_python.py` |
| Dart / Flutter | `supabase` / `supabase_flutter` | `tests/test_sdk_dart.py` |
| Swift (iOS, macOS) | `supabase-swift` | `tests/test_sdk_swift.py` |
| JavaScript, OwnDatabase-specific | `platform/sdk-js` | `tests/test_sdk_js.py` |

Each test runs the real library against a project, covering:
- **Database:** queries with filters, order, count and single; insert/update/delete; RPC.
- **Auth:** sign-up, sign-in, the current user, RLS as that user, sign-out.
- **Storage:** upload, download, list, public and signed URLs, remove.
- **Functions:** `functions.invoke`.
- **Realtime:** database changes and broadcast (JS, Python and Dart).

## Python

```python
from supabase import create_client

supabase = create_client("https://db.example.com/p/<projectId>", ANON_KEY)
rows = supabase.table("orders").select("*").eq("status", "open").execute().data
supabase.auth.sign_in_with_password({"email": email, "password": password})
supabase.storage.from_("avatars").upload("me.png", data, {"content-type": "image/png"})
```

## Flutter / Dart

```dart
await Supabase.initialize(url: 'https://db.example.com/p/<projectId>', anonKey: anonKey);
final supabase = Supabase.instance.client;
final rows = await supabase.from('orders').select().eq('status', 'open');
```

In plain Dart (no Flutter), pass `authOptions: AuthClientOptions(authFlowType: AuthFlowType.implicit)`
or provide an async storage. `supabase_flutter` does that for you.

## Swift

```swift
let supabase = SupabaseClient(supabaseURL: URL(string: "https://db.example.com/p/<projectId>")!, supabaseKey: anonKey)
let orders: [Order] = try await supabase.from("orders").select().eq("status", value: "open").execute().value
```

## Notes

- **Realtime:** use `schema: 'public'` in `postgres_changes` filters; it means the project's schema.
- **Sign-in methods:** OAuth, anonymous sign-ins, phone OTP, MFA (TOTP and SMS) and SSO work through
  the same client calls. See [oauth.md](oauth.md), [anonymous-auth.md](anonymous-auth.md),
  [phone-auth.md](phone-auth.md), [mfa.md](mfa.md) and [sso.md](sso.md).
- **No management API:** Supabase's management API isn't provided, so `supabase` CLI project commands
  don't apply. Use the dashboard, `/api` or the `odb` CLI.
