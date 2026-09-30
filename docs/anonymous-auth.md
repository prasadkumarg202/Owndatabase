# Anonymous sign-ins

Let people use your app before they sign up, then keep their data when they do. This works like
Supabase's `signInAnonymously()`.

Enable it in **Authentication → Settings → Anonymous sign-ins** (`enable_anonymous_sign_ins`, off by
default).

```js
const { data } = await supabase.auth.signInAnonymously({ options: { data: { theme: 'dark' } } });
data.user.is_anonymous // true

// later: make the account permanent, keeping its id and data
await supabase.auth.updateUser({ email: 'me@example.com' });
await supabase.auth.updateUser({ password: '...' });
```

- The guest gets a normal session in the `authenticated` role, with its own user id, so RLS policies
  on `auth.uid()` work as for any user. The JWT carries `is_anonymous: true`. Use `auth.jwt()` in
  policies that should exclude guests:

  ```sql
  create policy "members only" on premium_content for select to authenticated
    using ((auth.jwt() ->> 'is_anonymous')::boolean is not true);
  ```

- **Converting:** adding an email makes the user permanent at once. If the project requires email
  confirmation, the user stays anonymous until the address is confirmed with the code or link sent
  to it. Confirming a phone number (`updateUser({ phone })` and then `verifyOtp`) converts the user too.
- **Limits:** 30 anonymous sign-ins per hour per IP (`ANONYMOUS_SIGNUPS_PER_HOUR`), plus the
  project's user quota and the "allow new users to sign up" setting. Turn on CAPTCHA (bot protection)
  to keep automated sign-ups out.
- Anonymous users appear in the dashboard's user list marked "anonymous". They are not deleted
  automatically.
