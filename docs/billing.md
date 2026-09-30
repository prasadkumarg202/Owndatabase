# Billing

For operators who charge organizations for using the platform. **Off by
default** — with billing off nothing is enforced and existing organizations and
projects are untouched. Switch it with `BILLING_ENABLED=true` (default) or at
runtime (platform admins):

```http
PUT /api/admin/billing/settings   { "enabled": true }
```

## Plans

| Plan | Price | Projects | Project limits | Included per month | Overage |
|---|---|---|---|---|---|
| Free | 0 | 2 | 50k API req/day, 20k function calls/day, 1 GB storage, 500 MB database, 50k users, 200 realtime | — | — |
| Pro | $25 | 10 | 100 GB storage, 8 GB database, 1,000 realtime | 5M API requests, 2M function calls, 100 GB storage, 8 GB database | per 1k requests / 1k calls / GB |
| Team | $599 | unlimited | 5,000 realtime | 50M, 20M, 500 GB, 50 GB | lower rates |

Change prices, currency (`usd`, `inr`, …; amounts in the minor unit — cents,
paise), caps and limits with `PUT /api/admin/billing/plans/:id`; a new id
creates a plan. Branches do not count toward the project cap. A plan's
`project_limits` are applied to every project of the organization
([limits.md](limits.md)) except projects whose limits a platform admin set by hand.

## Subscriptions

Once billing is on, an organization without a subscription is on **Free**.
Owners and members with the `billing` role manage it in Organizations → Billing
or via the API:

| | |
|---|---|
| `GET /api/organizations/:id/billing` | plan, this month's usage vs included, estimated charge, invoices |
| `POST …/billing/subscribe {plan_id}` | paid plan: an invoice for the first month; the plan applies when it is paid. Free: at the end of the paid period |
| `POST …/billing/cancel` | back to Free at the end of the period |
| `POST …/billing/invoices/:id/pay` | (re)create the payment link |

Platform admins can assign a plan without payment:
`PUT /api/admin/billing/organizations/:id/plan {plan_id}`.

## Usage and invoices

Every hour the control API records each project's usage for the day (API
requests, function invocations, storage, database size, users). On the 1st of
a month (UTC) it creates the previous month's invoice for each organization:
plan price + overage (requests and function calls summed over the month;
storage and database at their peak). Admins can also run
`POST /api/admin/billing/usage/snapshot` and
`POST /api/admin/billing/invoices/generate {period: "YYYY-MM"}` (idempotent).
Unpaid invoices past `due_at` + `BILLING_GRACE_DAYS` (14) mark the
subscription `past_due` (shown in the dashboard; projects keep running).

These are usage statements, not tax invoices: add GST/VAT handling in your
payment provider or accounting system.

## Payments

`BILLING_PROVIDER`:

| | |
|---|---|
| `manual` | no online payment; admins record payments: `POST /api/admin/billing/invoices/:id/mark-paid` (or `/void`) |
| `stripe` | each invoice gets a Stripe Checkout link. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; point a webhook for `checkout.session.completed` at `https://<platform>/api/billing/webhooks/stripe` |
| `razorpay` | each invoice gets a Razorpay payment link. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; webhook for `payment_link.paid` at `…/api/billing/webhooks/razorpay` |

Webhooks are verified (Stripe signature with a 5-minute tolerance, Razorpay
HMAC) and processed once per event id. The Stripe and Razorpay payment-link
calls are not exercised by the test suite (they need live keys); the webhook
handling is.
