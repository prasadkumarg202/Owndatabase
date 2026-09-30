/**
 * Billing API (docs/billing.md). All routes answer 404 while billing is off,
 * except /api/billing/plans and PUT /api/admin/billing/settings { enabled }.
 *
 * Organization (owners and billing members; admins can view):
 *   GET  /api/organizations/:id/billing                         plan, usage this period, invoices
 *   POST /api/organizations/:id/billing/subscribe  { plan_id }  free → at once; paid → upgrade invoice, applied when paid
 *   POST /api/organizations/:id/billing/cancel                  back to Free at the end of the period
 *   POST /api/organizations/:id/billing/invoices/:invoiceId/pay (re)create the payment link
 *
 * Platform admins:
 *   PUT  /api/admin/billing/organizations/:id/plan { plan_id }  assign a plan (no payment)
 *   PUT  /api/admin/billing/plans/:planId                       edit a plan
 *   POST /api/admin/billing/usage/snapshot                      record today's usage now
 *   POST /api/admin/billing/invoices/generate { period: 'YYYY-MM' }
 *   POST /api/admin/billing/invoices/:invoiceId/mark-paid | void
 *
 * Payment webhooks (signature-verified, idempotent):
 *   POST /api/billing/webhooks/stripe     checkout.session.completed
 *   POST /api/billing/webhooks/razorpay   payment_link.paid
 */
import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { audit, requirePlatformAdmin, userId } from '../lib/access.js';
import {
  applyPlan, attachPaymentLink, billingEnabled, setBillingEnabled, createInvoice, generatePeriodInvoices, getPlan, markInvoicePaid, monthBounds, orgUsage,
  priceLines, snapshotUsage, subscriptionFor, verifyRazorpay, verifyStripe,
} from '../lib/billing.js';

const tags = { tags: ['billing'], security: [{ bearerAuth: [] }] };
const uuid = /^[0-9a-f-]{36}$/i;

function off(reply: FastifyReply) {
  return reply.status(404).send({ error: 'Not Found', message: 'Billing is not enabled on this platform' });
}

async function orgRole(orgId: string, uid: string) {
  if (!uuid.test(orgId)) return null;
  const [m] = await db`SELECT role FROM control_plane.organization_members WHERE organization_id = ${orgId} AND user_id = ${uid}`;
  return (m?.['role'] as string) ?? null;
}

async function guard(request: FastifyRequest, reply: FastifyReply, roles: string[]) {
  if (!(await billingEnabled())) { off(reply); return null; }
  const { id } = request.params as { id: string };
  const role = await orgRole(id, userId(request));
  if (!role) { reply.status(404).send({ error: 'Not Found', message: 'Organization not found' }); return null; }
  if (!roles.includes(role)) { reply.status(403).send({ error: 'Forbidden', message: `Requires one of: ${roles.join(', ')}` }); return null; }
  return id;
}

export const billingRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  const auth = { preValidation: [server.authenticate], schema: tags };

  server.get('/api/billing/plans', auth, async (_request, reply) => {
    const plans = await db`SELECT id, name, currency, price_monthly, max_projects, project_limits, included, overage FROM control_plane.plans WHERE is_public ORDER BY sort`;
    return reply.send({ data: plans.map((p) => ({ ...p, price_monthly: Number(p['price_monthly']) })), enabled: await billingEnabled() });
  });

  server.get('/api/organizations/:id/billing', auth, async (request, reply) => {
    const id = await guard(request, reply, ['owner', 'admin', 'billing']);
    if (!id) return;
    const sub = await subscriptionFor(id);
    const plan = (await getPlan(sub!['plan_id'] as string))!;
    const { start, end } = monthBounds();
    const usage = await orgUsage(id, start, end);
    const invoices = await db`
      SELECT id, number, kind, plan_id, period_start, period_end, currency, total, status, payment_url, issued_at, due_at, paid_at, lines
      FROM control_plane.invoices WHERE organization_id = ${id} ORDER BY created_at DESC LIMIT 24`;
    return reply.send({
      subscription: sub, plan,
      period: { start, end },
      usage, included: plan.included,
      estimated_lines: priceLines(plan, usage),
      invoices: invoices.map((i) => ({ ...i, total: Number(i['total']) })),
    });
  });

  server.post('/api/organizations/:id/billing/subscribe', auth, async (request, reply) => {
    const id = await guard(request, reply, ['owner', 'billing']);
    if (!id) return;
    const input = z.object({ plan_id: z.string().min(1).max(40) }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'plan_id is required' });
    const plan = await getPlan(input.data.plan_id);
    const [pub] = plan ? await db`SELECT is_public FROM control_plane.plans WHERE id = ${plan.id}` : [];
    if (!plan || !pub?.['is_public']) return reply.status(404).send({ error: 'Not Found', message: 'Unknown plan' });
    const sub = await subscriptionFor(id);
    if (sub!['plan_id'] === plan.id && !sub!['cancel_at_period_end']) return reply.status(409).send({ error: 'Conflict', message: `Already on ${plan.name}` });

    if (plan.price_monthly === 0) {
      // downgrade to a free plan: at the end of the paid period
      const current = (await getPlan(sub!['plan_id'] as string))!;
      if (current.price_monthly > 0) {
        await db`UPDATE control_plane.subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW() WHERE organization_id = ${id}`;
        await audit(request, 'billing.downgrade_scheduled', { type: 'organization', id, orgId: id }, { plan: plan.id });
        return reply.send({ status: 'scheduled', effective: sub!['current_period_end'] });
      }
      await applyPlan(id, plan.id);
      return reply.send({ status: 'active', plan_id: plan.id });
    }
    // paid plan: an upgrade invoice for the first month; the plan applies once it is paid
    const { start, end } = monthBounds();
    const inv = await createInvoice(id, 'upgrade', plan, start, end, priceLines(plan, { api_requests: 0, function_invocations: 0, storage_gb: 0, database_gb: 0 }));
    await db`UPDATE control_plane.subscriptions SET pending_plan_id = ${plan.id}, updated_at = NOW() WHERE organization_id = ${id}`;
    await audit(request, 'billing.upgrade_started', { type: 'organization', id, orgId: id }, { plan: plan.id, invoice: inv['number'] });
    return reply.status(201).send({ status: 'payment_required', invoice: { ...inv, total: Number(inv['total']) }, payment_url: inv['payment_url'] });
  });

  server.post('/api/organizations/:id/billing/cancel', auth, async (request, reply) => {
    const id = await guard(request, reply, ['owner', 'billing']);
    if (!id) return;
    const [s] = await db`UPDATE control_plane.subscriptions SET cancel_at_period_end = TRUE, updated_at = NOW() WHERE organization_id = ${id} AND plan_id <> 'free' RETURNING current_period_end`;
    if (!s) return reply.status(409).send({ error: 'Conflict', message: 'Already on the Free plan' });
    await audit(request, 'billing.canceled', { type: 'organization', id, orgId: id });
    return reply.send({ status: 'scheduled', effective: s['current_period_end'] });
  });

  server.post('/api/organizations/:id/billing/invoices/:invoiceId/pay', auth, async (request, reply) => {
    const id = await guard(request, reply, ['owner', 'billing']);
    if (!id) return;
    const { invoiceId } = request.params as { invoiceId: string };
    if (!uuid.test(invoiceId)) return reply.status(404).send({ error: 'Not Found', message: 'Invoice not found' });
    const [inv] = await db`SELECT * FROM control_plane.invoices WHERE id = ${invoiceId} AND organization_id = ${id}`;
    if (!inv) return reply.status(404).send({ error: 'Not Found', message: 'Invoice not found' });
    if (inv['status'] !== 'open') return reply.status(409).send({ error: 'Conflict', message: `Invoice is ${inv['status']}` });
    if (config.billingProvider === 'manual') return reply.status(409).send({ error: 'Conflict', message: 'Online payment is not configured; the platform operator records payments' });
    try { await attachPaymentLink(inv); } catch (err) { return reply.status(502).send({ error: 'Bad Gateway', message: (err as Error).message }); }
    const [fresh] = await db`SELECT payment_url FROM control_plane.invoices WHERE id = ${invoiceId}`;
    return reply.send({ payment_url: fresh!['payment_url'] });
  });

  // ── platform admin ────────────────────────────────────────────────────────
  const admin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await billingEnabled())) { off(reply); return false; }
    return requirePlatformAdmin(request, reply);
  };

  server.put('/api/admin/billing/settings', auth, async (request, reply) => {
    if (!(await requirePlatformAdmin(request, reply))) return;
    const input = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'enabled (boolean) is required' });
    await setBillingEnabled(input.data.enabled);
    await audit(request, input.data.enabled ? 'billing.enabled' : 'billing.disabled', { type: 'billing' });
    return reply.send({ enabled: input.data.enabled });
  });

  server.put('/api/admin/billing/organizations/:id/plan', auth, async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const { id } = request.params as { id: string };
    const input = z.object({ plan_id: z.string().min(1).max(40) }).safeParse(request.body);
    if (!input.success || !uuid.test(id)) return reply.status(400).send({ error: 'Validation Error', message: 'plan_id is required' });
    if (!(await getPlan(input.data.plan_id))) return reply.status(404).send({ error: 'Not Found', message: 'Unknown plan' });
    const [org] = await db`SELECT 1 FROM control_plane.organizations WHERE id = ${id}`;
    if (!org) return reply.status(404).send({ error: 'Not Found', message: 'Organization not found' });
    await applyPlan(id, input.data.plan_id, { provider: 'manual' });
    await audit(request, 'billing.plan_assigned', { type: 'organization', id, orgId: id }, { plan: input.data.plan_id });
    return reply.send({ organization_id: id, plan_id: input.data.plan_id });
  });

  server.put('/api/admin/billing/plans/:planId', auth, async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const { planId } = request.params as { planId: string };
    const money = z.number().int().min(0);
    const input = z.object({
      name: z.string().min(1).max(100), currency: z.string().length(3).toLowerCase(), price_monthly: money,
      max_projects: z.number().int().min(1).nullable(), project_limits: z.record(z.number().int().min(0)),
      included: z.record(z.number().min(0)), overage: z.record(money), is_public: z.boolean(),
    }).partial().safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: input.error.errors[0]?.message ?? 'Invalid input' });
    const cur = await getPlan(planId);
    const b = input.data;
    const [row] = cur
      ? await db`UPDATE control_plane.plans SET name = ${b.name ?? cur.name}, currency = ${b.currency ?? cur.currency}, price_monthly = ${b.price_monthly ?? cur.price_monthly},
                   max_projects = ${b.max_projects === undefined ? cur.max_projects : b.max_projects}, project_limits = ${db.json((b.project_limits ?? cur.project_limits) as any)},
                   included = ${db.json((b.included ?? cur.included) as any)}, overage = ${db.json((b.overage ?? cur.overage) as any)},
                   is_public = COALESCE(${b.is_public ?? null}, is_public) WHERE id = ${planId} RETURNING *`
      : await db`INSERT INTO control_plane.plans (id, name, currency, price_monthly, max_projects, project_limits, included, overage, is_public)
                 VALUES (${planId}, ${b.name ?? planId}, ${b.currency ?? 'usd'}, ${b.price_monthly ?? 0}, ${b.max_projects ?? null},
                         ${db.json((b.project_limits ?? {}) as any)}, ${db.json((b.included ?? {}) as any)}, ${db.json((b.overage ?? {}) as any)}, ${b.is_public ?? true}) RETURNING *`;
    await audit(request, 'billing.plan_updated', { type: 'plan', id: planId }, { fields: Object.keys(b) });
    return reply.send({ ...row, price_monthly: Number(row!['price_monthly']) });
  });

  server.post('/api/admin/billing/usage/snapshot', auth, async (request, reply) => {
    if (!(await admin(request, reply))) return;
    await snapshotUsage();
    return reply.send({ success: true });
  });

  server.post('/api/admin/billing/invoices/generate', auth, async (request, reply) => {
    if (!(await admin(request, reply))) return;
    const input = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'Validation Error', message: 'period must be YYYY-MM' });
    const created = await generatePeriodInvoices(`${input.data.period}-01`);
    await audit(request, 'billing.invoices_generated', { type: 'billing' }, { period: input.data.period, count: created.length });
    return reply.send({ created });
  });

  for (const action of ['mark-paid', 'void'] as const) {
    server.post(`/api/admin/billing/invoices/:invoiceId/${action}`, auth, async (request, reply) => {
      if (!(await admin(request, reply))) return;
      const { invoiceId } = request.params as { invoiceId: string };
      if (!uuid.test(invoiceId)) return reply.status(404).send({ error: 'Not Found', message: 'Invoice not found' });
      const ok = action === 'mark-paid'
        ? await markInvoicePaid(invoiceId, `manual:${userId(request)}`)
        : (await db`UPDATE control_plane.invoices SET status = 'void' WHERE id = ${invoiceId} AND status = 'open' RETURNING id`).length > 0;
      if (!ok) return reply.status(409).send({ error: 'Conflict', message: 'Invoice not found or not open' });
      if (action === 'void') await db`UPDATE control_plane.subscriptions s SET pending_plan_id = NULL FROM control_plane.invoices i WHERE i.id = ${invoiceId} AND i.kind = 'upgrade' AND s.organization_id = i.organization_id`;
      await audit(request, `billing.invoice_${action.replace('-', '_')}`, { type: 'invoice', id: invoiceId });
      return reply.send({ success: true });
    });
  }

  // ── webhooks: raw body for signature checks ──────────────────────────────
  await server.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    const once = async (provider: string, eventId: string) =>
      (await db`INSERT INTO control_plane.billing_events (provider, event_id) VALUES (${provider}, ${eventId}) ON CONFLICT DO NOTHING RETURNING event_id`).length > 0;

    hooks.post('/api/billing/webhooks/stripe', async (request, reply) => {
      if (!(await billingEnabled())) return off(reply);
      const raw = String(request.body ?? '');
      if (!verifyStripe(raw, request.headers['stripe-signature'] as string | undefined)) return reply.status(400).send({ error: 'Invalid signature' });
      const event = JSON.parse(raw) as any;
      if (!(await once('stripe', String(event.id)))) return reply.send({ received: true, duplicate: true });
      if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
        const invoiceId = event.data.object.metadata?.invoice_id ?? event.data.object.client_reference_id;
        if (invoiceId && uuid.test(invoiceId)) await markInvoicePaid(invoiceId, `stripe:${event.data.object.id}`);
      }
      return reply.send({ received: true });
    });

    hooks.post('/api/billing/webhooks/razorpay', async (request, reply) => {
      if (!(await billingEnabled())) return off(reply);
      const raw = String(request.body ?? '');
      if (!verifyRazorpay(raw, request.headers['x-razorpay-signature'] as string | undefined)) return reply.status(400).send({ error: 'Invalid signature' });
      const event = JSON.parse(raw) as any;
      const eventId = String(request.headers['x-razorpay-event-id'] ?? `${event.event}:${event.payload?.payment_link?.entity?.id ?? event.created_at}`);
      if (!(await once('razorpay', eventId))) return reply.send({ received: true, duplicate: true });
      if (event.event === 'payment_link.paid') {
        const link = event.payload?.payment_link?.entity;
        const invoiceId = link?.notes?.invoice_id;
        if (invoiceId && uuid.test(invoiceId)) await markInvoicePaid(invoiceId, `razorpay:${link.id}`);
      }
      return reply.send({ received: true });
    });
  });
};
