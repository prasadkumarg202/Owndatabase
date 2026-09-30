# Multi-factor authentication

Two kinds of second factor, as in `supabase.auth.mfa`:

| Factor | Setting | How |
|---|---|---|
| Authenticator app (TOTP) | `enable_mfa` (on by default) | the app scans the `otpauth://` URI from enrolment |
| SMS code | `enable_mfa_phone` (off by default) | a 6-digit code is texted through the project's SMS provider ([phone-auth.md](phone-auth.md)) |

```js
// enrol (the user is signed in)
const { data: factor } = await supabase.auth.mfa.enroll({ factorType: 'phone', phone: '+919876543210' });
// or: await supabase.auth.mfa.enroll({ factorType: 'totp' })  → factor.totp.qr_code / uri

// prove it: challenge, then verify with the code
const { data: challenge } = await supabase.auth.mfa.challenge({ factorId: factor.id });
await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code: '123456' });

// on later sign-ins the session is aal1 until a factor is verified
const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();   // { currentLevel, nextLevel }
```

**API:**

| Endpoint | Does |
|---|---|
| `GET /factors` | list the user's factors |
| `POST /factors` `{ factor_type, phone?, friendly_name? }` | enrol a factor |
| `POST /factors/:id/challenge` | start a challenge |
| `POST /factors/:id/verify` `{ code, challenge_id }` | verify the code; returns an `aal2` session (`amr` is `totp` or `sms`) |
| `DELETE /factors/:id` | remove a factor (needs `aal2`) |

**SMS codes:**
- **Lifetime:** a code expires after 5 minutes and allows 5 attempts. Attempts are counted before
  checking, so parallel guesses can't get past the limit.
- **Rate limits:** 5 challenges per hour per factor, and 20 per hour per IP.
- **Test numbers:** the project's test numbers (`sms.test_otp`) get their fixed code and no SMS.

**Adding and removing factors:** with a factor already verified, adding another or removing one needs
an `aal2` session. So does changing the password, email or phone. Use RLS to protect data behind
`aal2`:

```sql
create policy "aal2 only" on secrets for select to authenticated using ((auth.jwt() ->> 'aal') = 'aal2');
```
