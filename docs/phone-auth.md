# Phone auth (SMS OTP)

End users can sign in with a one-time code sent by SMS, or with a phone number
and password. The API matches Supabase (GoTrue), so `supabase-js` calls such as
`signInWithOtp({ phone })`, `verifyOtp({ phone, token, type: 'sms' })` and
`updateUser({ phone })` work unchanged.

## Turning it on

Project → Authentication → Settings → **Phone (SMS)**:

| Setting | Meaning |
|---|---|
| Enable phone sign-in | Off by default. Every phone endpoint returns 403 until it is on. |
| Code lifetime | Minutes an SMS code stays valid (default 10). |
| SMS provider | **Platform default** (the `TWILIO_*` env vars on the auth service), **Twilio** (per-project account), or **Webhook**. |
| Message template | Must contain `{{code}}`. |

Secrets (Twilio auth token, webhook signing secret) are masked when read back;
sending the mask unchanged keeps the stored value.

### Webhook provider (MSG91, Gupshup, AWS SNS, WhatsApp, ...)

For each code the auth service POSTs:

```json
{ "type": "sms_otp", "project_id": "…", "to": "+919876543210", "body": "Your verification code is 123456", "code": "123456" }
```

with `x-odb-signature: sha256=<HMAC-SHA256 of the raw body with the signing secret>`.
Return any 2xx once the message is accepted. Private / internal addresses are
refused (set `WEBHOOK_ALLOW_PRIVATE=true` on the auth service to allow them, for
example an adapter on the same Docker network).

## API

All under `/auth/v1/:projectId`, with the project's `apikey` header.

| Call | Body | Result |
|---|---|---|
| `POST /otp` | `{ phone, create_user?, data? }` | Sends a code. Same response whether or not the number exists. |
| `POST /verify` | `{ type: "sms", phone, token }` | Session (access + refresh token). Marks the number verified. |
| `POST /signup` | `{ phone, password, data? }` | User with `session: null`; confirm with `POST /verify type=sms`. |
| `POST /token?grant_type=password` | `{ phone, password }` | Session. 403 until the number is confirmed. |
| `PUT /user` (signed in) | `{ phone }` | Sends a code to the new number; returns `new_phone`. |
| `POST /verify` | `{ type: "phone_change", phone, token }` | Applies the new number. |

Numbers are normalised to E.164 (`+919876543210`); spaces, dashes, brackets and
a leading `00` are accepted on input. A missing country code is not guessed.

## Abuse protection

- 5 codes per number per hour and 20 per client IP per hour (SMS pumping / toll fraud).
- 5 wrong guesses invalidate a code; only the newest code for a number is valid.
- Password logins by phone share the per-identifier lockout with email logins.
- With MFA enrolled, changing the phone number needs an `aal2` session.

## Development

With `AUTH_DEV_MAILBOX=true`, messages are also captured and readable at
`GET /auth/v1/:projectId/_dev/sms?phone=+91…` (never enable in production).
Without a provider or the dev mailbox, phone endpoints return 501.
