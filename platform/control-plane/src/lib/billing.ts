/**
 * Billing core (docs/billing.md). Opt-in: nothing here runs or is enforced
 * unless billing is enabled (BILLING_ENABLED sets the default; platform admins
 * can switch it at runtime: PUT /api/admin/billing/settings).
 *
 * - Plans set the organization's project cap and the limits of its projects
 *   (projects whose limits a platform admin set by hand keep them).
 * - Usage is snapshotted per project per day (usage_daily) from the daily
 *   counters and current sizes.
 * - Invoices (calendar months, UTC): the plan price + overage above the plan's
 *   included amounts. Paid manually, or through a Stripe Checkout / Razorpay
 *   payment link whose webhook marks the invoice paid.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db } from './db.js';
import { billingProfile, computeGst, gstSettings } from './gst.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

export interface Plan {
  id: string; name: string; currency: string; price_monthly: number; max_projects: number | null;
  project_limits: Record<string, number>; included: Record<string, number>; overage: Record<string, number>;
}

const GB = 1024 ** 3;

/** Marks in-process requests (server.inject) as branch creation; random per process, so clients cannot send it. */
export const BRANCH_REQUEST_TOKEN = randomBytes(24).toString('hex');

export function monthBounds(d = new Date()): { start: string; end: string } {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) };
}

export async function getPlan(id: string): Promise<Plan | null> {
  const [p] = await db`SELECT * FROM control_plane.plans WHERE id = ${id}`;
  return p ? ({ ...p, price_monthly: Number(p['price_monthly']) } as unknown as Plan) : null;
}

let enabledCache = { value: false, at: 0 };

/** Billing on/off: the platform_settings override, else BILLING_ENABLED (cached for 5 s). */
export async function billingEnabled(): Promise<boolean> {
  if (Date.now() - enabledCache.at < 5000) return enabledCache.value;
  const rows = await db`SELECT value FROM control_plane.platform_settings WHERE key = 'billing_enabled'`.catch(() => []);
  enabledCache = { value: rows[0] ? rows[0]['value'] === true : !!config.billingEnabled, at: Date.now() };
  return enabledCache.value;
}

export async function setBillingEnabled(value: boolean) {
  await db`INSERT INTO control_plane.platform_settings (key, value) VALUES ('billing_enabled', ${db.json(value)})
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
  enabledCache = { value, at: Date.now() };
}

/** The organization's subscription, creating a Free one when billing is on and there is none. */
export async function subscriptionFor(orgId: string): Promise<Record<string, any> | null> {
  if (!(await billingEnabled())) return null;
  let [s] = await db`SELECT * FROM control_plane.subscriptions WHERE organization_id = ${orgId}`;
  if (!s) {
    [s] = await db`
      INSERT INTO control_plane.subscriptions (organization_id, plan_id) VALUES (${orgId}, 'free')
      ON CONFLICT (organization_id) DO UPDATE SET updated_at = control_plane.subscriptions.updated_at RETURNING *`;
    await db`UPDATE control_plane.organizations SET plan = 'free' WHERE id = ${orgId}`.catch(() => {});
  }
  return s ?? null;
}

/** Plan limits for a new project of this organization (null when billing is off). */
export async function planLimitsForNewProject(orgId: string): Promise<Record<string, number> | null> {
  const sub = await subscriptionFor(orgId);
  if (!sub) return null;
  return (await getPlan(sub['plan_id'] as string))?.project_limits ?? null;
}

/** Refuses a new project over the plan's cap: an error message, or null. */
export async function projectCapError(orgId: string): Promise<string | null> {
  const sub = await subscriptionFor(orgId);
  if (!sub) return null;
  const plan = await getPlan(sub['plan_id'] as string);
  if (!plan?.max_projects) return null;
  const [{ n }] = await db`
    SELECT count(*)::int AS n FROM control_plane.projects
    WHERE organization_id = ${orgId} AND parent_project_id IS NULL AND status <> 'deleting'` as any;
  return n >= plan.max_projects ? `The ${plan.name} plan allows ${plan.max_projects} projects. Upgrade to create more.` : null;
}

/** Sets an organization's plan and applies its limits to the org's projects (except hand-tuned ones). */
export async function applyPlan(orgId: string, planId: string, opts: { provider?: string } = {}) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error(`Unknown plan ${planId}`);
  const { start, end } = monthBounds();
  await db`
    INSERT INTO control_plane.subscriptions (organization_id, plan_id, status, current_period_start, current_period_end, provider)
    VALUES (${orgId}, ${planId}, 'active', ${start}, ${end}, ${opts.provider ?? config.billingProvider})
    ON CONFLICT (organization_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, pending_plan_id = NULL, status = 'active',
      cancel_at_period_end = FALSE, provider = EXCLUDED.provider, updated_at = NOW()`;
  await db`UPDATE control_plane.organizations SET plan = ${planId} WHERE id = ${orgId}`.catch(() => {});
  const projects = await db`
    UPDATE control_plane.projects SET settings = jsonb_set(COALESCE(settings, '{}'), '{limits}', ${db.json(plan.project_limits as any)})
    WHERE organization_id = ${orgId} AND COALESCE((settings->>'limits_custom')::boolean, FALSE) = FALSE
    RETURNING id`;
  for (const p of projects) await redis.publish('odb:project-changed', p['id'] as string).catch(() => {});
}

// ── usage metering ──────────────────────────────────────────────────────────
export async function snapshotUsage(day = new Date()) {
  const d = day.toISOString().slice(0, 10);
  const projects = await db`SELECT id, organization_id, db_schema FROM control_plane.projects WHERE status IN ('active', 'paused')`;
  for (const p of projects) {
    const id = p['id'] as string;
    const counters = await redis.hgetall(`odb:usage:${id}:${d}`).catch(() => ({} as Record<string, string>));
    const [u] = await db`
      SELECT
        (SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${p['db_schema'] as string} AND c.relkind IN ('r', 'm')) AS database_bytes,
        (SELECT COALESCE(sum(o.size_bytes), 0)::bigint FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id
          WHERE b.project_id = ${id} AND NOT o.is_deleted) AS storage_bytes,
        (SELECT count(*)::int FROM auth.users WHERE project_id = ${id} AND deleted_at IS NULL) AS auth_users`;
    await db`
      INSERT INTO control_plane.usage_daily (project_id, organization_id, day, api_requests, function_invocations, storage_bytes, database_bytes, auth_users)
      VALUES (${id}, ${p['organization_id'] as string}, ${d}, ${Number(counters['rest_requests'] ?? 0)}, ${Number(counters['function_invocations'] ?? 0)},
              ${u!['storage_bytes'] as string}, ${u!['database_bytes'] as string}, ${u!['auth_users'] as number})
      ON CONFLICT (project_id, day) DO UPDATE SET api_requests = GREATEST(control_plane.usage_daily.api_requests, EXCLUDED.api_requests),
        function_invocations = GREATEST(control_plane.usage_daily.function_invocations, EXCLUDED.function_invocations),
        storage_bytes = EXCLUDED.storage_bytes, database_bytes = EXCLUDED.database_bytes, auth_users = EXCLUDED.auth_users, updated_at = NOW()`;
  }
}

/** Organization usage for a period: request/function sums, storage/database peaks. */
export async function orgUsage(orgId: string, start: string, end: string) {
  const [u] = await db`
    SELECT COALESCE(sum(api_requests), 0)::bigint AS api_requests, COALESCE(sum(function_invocations), 0)::bigint AS function_invocations,
           COALESCE(max(storage_bytes), 0)::bigint AS storage_bytes, COALESCE(max(database_bytes), 0)::bigint AS database_bytes
    FROM (SELECT day, sum(api_requests) api_requests, sum(function_invocations) function_invocations,
                 sum(storage_bytes) storage_bytes, sum(database_bytes) database_bytes
          FROM control_plane.usage_daily WHERE organization_id = ${orgId} AND day >= ${start} AND day < ${end} GROUP BY day) d`;
  return {
    api_requests: Number(u!['api_requests']), function_invocations: Number(u!['function_invocations']),
    storage_gb: Number(u!['storage_bytes']) / GB, database_gb: Number(u!['database_bytes']) / GB,
  };
}

export interface InvoiceLine { description: string; quantity: number; unit: string; unit_amount: number; amount: number }

/** Base price + overage lines for a plan and usage. */
export function priceLines(plan: Plan, usage: Awaited<ReturnType<typeof orgUsage>>): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (plan.price_monthly > 0) lines.push({ description: `${plan.name} plan`, quantity: 1, unit: 'month', unit_amount: plan.price_monthly, amount: plan.price_monthly });
  const over = (used: number, included: number | undefined) => Math.max(0, used - (included ?? 0));
  const add = (description: string, qty: number, unit: string, price: number | undefined) => {
    if (qty > 0 && price) lines.push({ description, quantity: Math.round(qty * 1000) / 1000, unit, unit_amount: price, amount: Math.round(qty * price) });
  };
  add('API requests over the included amount', Math.ceil(over(usage.api_requests, plan.included['api_requests']) / 1000), '1k requests', plan.overage['api_requests_per_1k']);
  add('Function invocations over the included amount', Math.ceil(over(usage.function_invocations, plan.included['function_invocations']) / 1000), '1k invocations', plan.overage['function_invocations_per_1k']);
  add('Storage over the included amount (peak)', over(usage.storage_gb, plan.included['storage_gb']), 'GB', plan.overage['storage_gb']);
  add('Database size over the included amount (peak)', over(usage.database_gb, plan.included['database_gb']), 'GB', plan.overage['database_gb']);
  return lines;
}

async function nextInvoiceNumber() {
  const [r] = await db`SELECT nextval('control_plane.invoice_number_seq') AS n`;
  return `ODB-${new Date().getUTCFullYear()}-${String(r!['n']).padStart(6, '0')}`;
}

export async function createInvoice(orgId: string, kind: 'period' | 'upgrade', plan: Plan, start: string, end: string, lines: InvoiceLine[]): Promise<Record<string, any>> {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  // GST (docs/billing.md → GST): tax on top of the taxable value, with seller and customer snapshots
  const gst = await gstSettings();
  const profile = await billingProfile(orgId);
  const [org] = await db`SELECT name FROM control_plane.organizations WHERE id = ${orgId}`;
  const tax = gst ? computeGst(gst, profile, subtotal) : null;
  const taxTotal = tax ? tax.lines.reduce((s, t) => s + t.amount, 0) : 0;
  const total = subtotal + taxTotal;
  const buyer = profile ? { ...profile, organization: org?.['name'] ?? null } : { organization: org?.['name'] ?? null };
  const [inv] = await db`
    INSERT INTO control_plane.invoices (organization_id, number, kind, plan_id, period_start, period_end, currency, lines, total, status, provider, paid_at,
                                        subtotal, tax_total, tax_lines, tax_note, place_of_supply, sac_code, seller, buyer)
    VALUES (${orgId}, ${await nextInvoiceNumber()}, ${kind}, ${plan.id}, ${start}, ${end}, ${plan.currency}, ${db.json(lines as any)}, ${total},
            ${total === 0 ? 'paid' : 'open'}, ${config.billingProvider}, ${total === 0 ? new Date() : null},
            ${subtotal}, ${taxTotal}, ${db.json((tax?.lines ?? []) as any)}, ${tax?.note ?? null}, ${tax?.placeOfSupply ?? null},
            ${gst?.sac_code ?? null}, ${gst ? db.json(gst as any) : null}, ${db.json(buyer as any)})
    RETURNING *`;
  if (total > 0) await attachPaymentLink(inv!).catch((err) => logger.warn({ err: (err as Error).message, invoice: inv!['id'] }, 'Payment link failed'));
  const [fresh] = await db`SELECT * FROM control_plane.invoices WHERE id = ${inv!['id'] as string}`;
  // BIGINT columns arrive as strings
  return { ...fresh!, total: Number(fresh!['total']), subtotal: fresh!['subtotal'] === null ? null : Number(fresh!['subtotal']), tax_total: Number(fresh!['tax_total']) };
}

/** Monthly invoices for a finished period (idempotent per organization and period). */
export async function generatePeriodInvoices(periodStart: string) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const { end } = monthBounds(start);
  const subs = await db`SELECT * FROM control_plane.subscriptions`;
  const created: string[] = [];
  for (const s of subs) {
    const orgId = s['organization_id'] as string;
    const [exists] = await db`SELECT 1 FROM control_plane.invoices WHERE organization_id = ${orgId} AND period_start = ${periodStart} AND kind = 'period' AND status <> 'void'`;
    if (exists) continue;
    const plan = await getPlan(s['plan_id'] as string);
    if (!plan) continue;
    const lines = priceLines(plan, await orgUsage(orgId, periodStart, end));
    if (!lines.length) continue;
    const inv = await createInvoice(orgId, 'period', plan, periodStart, end, lines);
    created.push(inv['id'] as string);
  }
  return created;
}

/** Marks an invoice paid; an upgrade invoice activates its plan. Returns false if it was not open. */
export async function markInvoicePaid(invoiceId: string, providerRef: string | null = null): Promise<boolean> {
  const [inv] = await db`
    UPDATE control_plane.invoices SET status = 'paid', paid_at = NOW(), provider_ref = COALESCE(${providerRef}, provider_ref)
    WHERE id = ${invoiceId} AND status = 'open' RETURNING *`;
  if (!inv) return false;
  if (inv['kind'] === 'upgrade' && inv['plan_id']) {
    await applyPlan(inv['organization_id'] as string, inv['plan_id'] as string);
  } else {
    await db`UPDATE control_plane.subscriptions SET status = 'active', updated_at = NOW()
             WHERE organization_id = ${inv['organization_id'] as string} AND status = 'past_due'
               AND NOT EXISTS (SELECT 1 FROM control_plane.invoices i WHERE i.organization_id = ${inv['organization_id'] as string}
                               AND i.status = 'open' AND i.due_at < NOW())`;
  }
  return true;
}

// ── payment providers ───────────────────────────────────────────────────────
async function attachPaymentLink(inv: Record<string, any>) {
  const amount = Number(inv['total']);
  const title = `OwnDatabase invoice ${inv['number']}`;
  const back = `${config.publicUrl.replace(/\/$/, '')}/organizations?invoice=${inv['id']}`;
  if (config.billingProvider === 'stripe' && config.stripeSecretKey) {
    const form = new URLSearchParams({
      mode: 'payment', success_url: `${back}&paid=1`, cancel_url: back, client_reference_id: String(inv['id']),
      'metadata[invoice_id]': String(inv['id']),
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': String(inv['currency']),
      'line_items[0][price_data][unit_amount]': String(amount), 'line_items[0][price_data][product_data][name]': title,
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', body: form, headers: { authorization: `Bearer ${config.stripeSecretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json() as any;
    if (!res.ok) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
    await db`UPDATE control_plane.invoices SET payment_url = ${body.url}, provider_ref = ${body.id}, provider = 'stripe' WHERE id = ${inv['id'] as string}`;
  } else if (config.billingProvider === 'razorpay' && config.razorpayKeyId && config.razorpayKeySecret) {
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount, currency: String(inv['currency']).toUpperCase(), description: title, reference_id: inv['number'], callback_url: back, callback_method: 'get', notes: { invoice_id: inv['id'] } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json() as any;
    if (!res.ok) throw new Error(`Razorpay: ${body?.error?.description ?? res.status}`);
    await db`UPDATE control_plane.invoices SET payment_url = ${body.short_url}, provider_ref = ${body.id}, provider = 'razorpay' WHERE id = ${inv['id'] as string}`;
  }
}

export { attachPaymentLink };

const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Stripe-Signature: t=<ts>,v1=<hex HMAC-SHA256 of "<ts>.<raw body>">; 5-minute tolerance. */
export function verifyStripe(raw: string, header: string | undefined): boolean {
  if (!config.stripeWebhookSecret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts['t']);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', config.stripeWebhookSecret).update(`${t}.${raw}`).digest('hex');
  return header.split(',').filter((kv) => kv.startsWith('v1=')).some((kv) => safeEqual(kv.slice(3), expected));
}

/** X-Razorpay-Signature: hex HMAC-SHA256 of the raw body. */
export function verifyRazorpay(raw: string, header: string | undefined): boolean {
  if (!config.razorpayWebhookSecret || !header) return false;
  return safeEqual(header, createHmac('sha256', config.razorpayWebhookSecret).update(raw).digest('hex'));
}

// ── scheduled work ──────────────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null;

export async function billingTick(now = new Date()) {
  await snapshotUsage(now);
  // yesterday's final numbers
  await snapshotUsage(new Date(now.getTime() - 86400_000)).catch(() => {});
  const { start } = monthBounds(now);
  const prev = monthBounds(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))).start;
  await generatePeriodInvoices(prev);
  // period rollover: cancellations take effect, periods advance
  const ended = await db`SELECT organization_id, cancel_at_period_end FROM control_plane.subscriptions WHERE current_period_end <= ${start}`;
  for (const s of ended) {
    if (s['cancel_at_period_end']) await applyPlan(s['organization_id'] as string, 'free');
    else await db`UPDATE control_plane.subscriptions SET current_period_start = ${start}, current_period_end = ${monthBounds(now).end}, updated_at = NOW()
                  WHERE organization_id = ${s['organization_id'] as string}`;
  }
  // unpaid past the grace period
  await db`
    UPDATE control_plane.subscriptions s SET status = 'past_due', updated_at = NOW()
    WHERE s.status = 'active' AND EXISTS (
      SELECT 1 FROM control_plane.invoices i WHERE i.organization_id = s.organization_id AND i.status = 'open'
        AND i.kind = 'period' AND i.due_at < NOW() - make_interval(days => ${config.billingGraceDays}))`;
}

export function startBilling(intervalMs = 3600_000) {
  const run = async () => {
    if (!(await billingEnabled().catch(() => false))) return;
    await billingTick().catch((err) => logger.warn({ err: (err as Error).message }, 'Billing tick failed'));
  };
  timer = setInterval(run, intervalMs);
  timer.unref();
  setTimeout(run, 10_000).unref();
  logger.info({ provider: config.billingProvider, enabled_by_default: !!config.billingEnabled }, 'Billing scheduler started');
}

export function stopBilling() { if (timer) clearInterval(timer); }
