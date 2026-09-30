'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api, formatDate } from '@/lib/api';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { CopyField } from '@/components/ui/CopyField';
import { useToast } from '@/components/ui/Toast';

const ROLES = ['owner', 'admin', 'developer', 'viewer', 'billing', 'support'];

function Members({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => api.get(`/organizations/${orgId}`) });
  const manager = ['owner', 'admin'].includes(org.data?.member_role);
  const invites = useQuery({ queryKey: ['invites', orgId], queryFn: () => api.get(`/organizations/${orgId}/invitations`).then((r) => r.data as any[]), enabled: manager });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [link, setLink] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () => api.post(`/organizations/${orgId}/invitations`, { email, role }),
    onSuccess: (r) => { setLink(r.invite_url); setEmail(''); toast.success(`Invitation sent to ${r.email}`); qc.invalidateQueries({ queryKey: ['invites', orgId] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/organizations/${orgId}/invitations/${id}`),
    onSuccess: () => { toast.success('Invitation revoked'); qc.invalidateQueries({ queryKey: ['invites', orgId] }); },
    onError: (e) => toast.error(e),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => api.patch(`/organizations/${orgId}/members/${userId}`, { role }),
    onSuccess: () => { toast.success('Role updated'); qc.invalidateQueries({ queryKey: ['org', orgId] }); },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/organizations/${orgId}/members/${userId}`),
    onSuccess: () => { toast.success('Member removed'); qc.invalidateQueries({ queryKey: ['org', orgId] }); },
    onError: (e) => toast.error(e),
  });

  const isOwner = org.data?.member_role === 'owner';
  return (
    <div className="space-y-6">
      <Card title="Members" bodyClassName="p-0">
        <DataTable testId="members-table" data={org.data?.members}
          columns={[
            { key: 'email', label: 'Email', render: (m: any) => <span>{m.email}{m.name ? <span className="ml-2 text-gray-400">{m.name}</span> : null}</span> },
            { key: 'role', label: 'Role', render: (m: any) => isOwner
              ? <select aria-label={`Role of ${m.email}`} className="rounded border border-gray-300 px-2 py-1 text-xs" value={m.role} onChange={(e) => changeRole.mutate({ userId: m.id, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
              : <Badge>{m.role}</Badge> },
            { key: 'joined_at', label: 'Joined', render: (m: any) => m.joined_at ? formatDate(m.joined_at, false) : '—' },
            { key: 'actions', label: '', render: (m: any) => manager && <button className="text-xs text-red-600 hover:underline" onClick={() => { if (confirm(`Remove ${m.email}?`)) remove.mutate(m.id); }}>Remove</button> },
          ]} />
      </Card>

      {manager && (
        <Card title="Invite people" description="They get an email with a link valid for 7 days. They can sign up with that address if they have no account yet.">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <div className="min-w-64 flex-1"><Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" /></div>
            <div className="w-40"><Select label="Role" value={role} onChange={(e) => setRole(e.target.value)} options={isOwner ? ROLES : ROLES.filter((r) => r !== 'owner')} /></div>
            <Button type="submit" loading={invite.isPending} data-testid="send-invite"><UserPlus className="h-4 w-4" />Invite</Button>
          </form>
          <ErrorBox error={invite.error} />
          {link && <div className="mt-3"><CopyField label="Invitation link (also emailed)" value={link} testId="invite-link" /></div>}
        </Card>
      )}

      {manager && (
        <Card title="Pending invitations" bodyClassName="p-0">
          <DataTable testId="invites-table" data={invites.data} empty="No pending invitations"
            columns={[
              { key: 'email', label: 'Email' },
              { key: 'role', label: 'Role', render: (i: any) => <Badge>{i.role}</Badge> },
              { key: 'invited_by_email', label: 'Invited by' },
              { key: 'expires_at', label: 'Expires', render: (i: any) => formatDate(i.expires_at, false) },
              { key: 'actions', label: '', render: (i: any) => <button className="text-xs text-red-600 hover:underline" onClick={() => revoke.mutate(i.id)}>Revoke</button> },
            ]} />
        </Card>
      )}
    </div>
  );
}

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);

/** The printable (tax) invoice needs the user's token, so it is fetched and opened as a blob. */
async function openInvoice(orgId: string, invoiceId: string) {
  const html = await api.get(`/organizations/${orgId}/billing/invoices/${invoiceId}/document`);
  window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank', 'noopener');
}

/** Legal name, GSTIN and address printed on invoices; the state decides CGST+SGST or IGST (docs/billing.md). */
function BillingDetails({ orgId }: { orgId: string }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['billing-profile', orgId], queryFn: () => api.get(`/organizations/${orgId}/billing/profile`) });
  const [f, setF] = useState<any>(null);
  const cur = f ?? { country: 'IN', ...(q.data?.profile ?? {}) };
  const set = (k: string, v: any) => setF({ ...cur, [k]: v });
  const save = useMutation({
    mutationFn: () => api.put(`/organizations/${orgId}/billing/profile`, {
      legal_name: cur.legal_name ?? '', gstin: cur.gstin || null, address_line1: cur.address_line1 ?? '', address_line2: cur.address_line2 ?? '',
      city: cur.city ?? '', postal_code: cur.postal_code ?? '', state_code: cur.state_code || null, country: cur.country || 'IN', email: cur.email || null,
    }),
    onSuccess: () => { toast.success('Billing details saved'); setF(null); q.refetch(); },
    onError: (e) => toast.error(e),
  });
  if (!q.data) return null;
  const states = Object.entries(q.data.states ?? {}) as [string, string][];
  return (
    <div className="rounded-md border border-gray-200 p-3" data-testid="billing-details">
      <p className="mb-2 text-sm font-medium">Billing details <span className="font-normal text-gray-500">(printed on invoices; GSTIN for a GST input tax credit)</span></p>
      <div className="grid gap-3 md:grid-cols-3">
        <Input label="Legal name" value={cur.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} />
        <Input label="GSTIN (optional)" value={cur.gstin ?? ''} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder="29ABCDE1234F1Z5" />
        <Input label="Billing email" value={cur.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        <Input label="Address" value={cur.address_line1 ?? ''} onChange={(e) => set('address_line1', e.target.value)} />
        <Input label="Address line 2" value={cur.address_line2 ?? ''} onChange={(e) => set('address_line2', e.target.value)} />
        <Input label="City" value={cur.city ?? ''} onChange={(e) => set('city', e.target.value)} />
        <Input label="Postal code" value={cur.postal_code ?? ''} onChange={(e) => set('postal_code', e.target.value)} />
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-700" htmlFor="bill-country">Country</label>
          <select id="bill-country" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={cur.country ?? 'IN'} onChange={(e) => set('country', e.target.value)}>
            <option value="IN">India</option>
            {['US', 'GB', 'AE', 'SG', 'DE', 'FR', 'CA', 'AU', 'NL', 'JP'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {(cur.country ?? 'IN') === 'IN' && (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="bill-state">State (GST)</label>
            <select id="bill-state" className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={cur.state_code ?? ''} onChange={(e) => set('state_code', e.target.value)}>
              <option value="">—</option>
              {states.map(([code, name]) => <option key={code} value={code}>{code} {name}</option>)}
            </select>
          </div>
        )}
      </div>
      <Button size="sm" className="mt-3" onClick={() => save.mutate()} loading={save.isPending} disabled={!cur.legal_name}>Save billing details</Button>
    </div>
  );
}

function Billing({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/billing/plans') });
  const b = useQuery({ queryKey: ['billing', orgId], queryFn: () => api.get(`/organizations/${orgId}/billing`), enabled: !!plans.data?.enabled, retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing', orgId] });
  const subscribe = useMutation({
    mutationFn: (planId: string) => api.post(`/organizations/${orgId}/billing/subscribe`, { plan_id: planId }),
    onSuccess: (r) => {
      refresh();
      if (r.payment_url) window.open(r.payment_url, '_blank', 'noopener');
      toast.success(r.status === 'payment_required' ? `Invoice ${r.invoice.number} created${r.payment_url ? '' : ' — the platform operator will confirm payment'}` : r.status === 'scheduled' ? 'Change takes effect at the end of the period' : 'Plan changed');
    },
    onError: (e) => toast.error(e),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/organizations/${orgId}/billing/cancel`), onSuccess: () => { toast.success('Your plan ends at the end of the period'); refresh(); }, onError: (e) => toast.error(e) });
  if (!plans.data?.enabled) return null;
  if (b.error) return null;   // not an owner / admin / billing member
  const d = b.data;
  if (!d) return <Card title="Billing"><p className="text-sm text-gray-500">Loading…</p></Card>;
  const inc = d.included ?? {};
  const rows: [string, number, number | undefined, (n: number) => string][] = [
    ['API requests', d.usage.api_requests, inc.api_requests, (n) => n.toLocaleString()],
    ['Function invocations', d.usage.function_invocations, inc.function_invocations, (n) => n.toLocaleString()],
    ['Storage (peak)', d.usage.storage_gb, inc.storage_gb, (n) => `${n.toFixed(2)} GB`],
    ['Database (peak)', d.usage.database_gb, inc.database_gb, (n) => `${n.toFixed(2)} GB`],
  ];
  const estimate = d.estimated_lines.reduce((s: number, l: any) => s + l.amount, 0);
  return (
    <Card title="Billing" description={`Current period ${d.period.start} – ${d.period.end}`}>
      <div className="space-y-5" data-testid="billing">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Plan: <strong>{d.plan.name}</strong></span>
          <Badge tone={d.subscription.status === 'active' ? 'green' : 'red'}>{d.subscription.status}</Badge>
          {d.subscription.pending_plan_id && <Badge tone="yellow">upgrade to {d.subscription.pending_plan_id} awaiting payment</Badge>}
          {d.subscription.cancel_at_period_end && <Badge tone="yellow">ends {d.subscription.current_period_end}</Badge>}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {plans.data.data.map((p: any) => (
            <div key={p.id} className={`rounded-md border p-3 ${p.id === d.plan.id ? 'border-blue-400 bg-blue-50' : 'border-gray-200'}`}>
              <div className="flex items-baseline justify-between"><span className="font-medium">{p.name}</span><span className="text-sm">{p.price_monthly ? `${money(p.price_monthly, p.currency)}/mo` : 'Free'}</span></div>
              <p className="mt-1 text-xs text-gray-500">{p.max_projects ? `${p.max_projects} projects` : 'Unlimited projects'}</p>
              {p.id !== d.plan.id && <Button size="sm" className="mt-2" variant="secondary" loading={subscribe.isPending} onClick={() => subscribe.mutate(p.id)} data-testid={`choose-${p.id}`}>Choose {p.name}</Button>}
            </div>
          ))}
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, used, included, fmt]) => (
              <tr key={label} className="border-b border-gray-100"><td className="py-1.5 text-gray-600">{label}</td>
                <td className="py-1.5 text-right">{fmt(used)}{included !== undefined ? <span className="text-gray-400"> / {fmt(included)} included</span> : null}</td></tr>
            ))}
            <tr><td className="py-1.5 font-medium">Estimated this period</td><td className="py-1.5 text-right font-medium">{money(estimate, d.plan.currency)}</td></tr>
          </tbody>
        </table>
        {d.plan.price_monthly > 0 && !d.subscription.cancel_at_period_end && (
          <Button size="sm" variant="ghost" onClick={() => { if (confirm('Move to the Free plan at the end of this period?')) cancel.mutate(); }}>Cancel plan</Button>
        )}
        <DataTable testId="invoices-table" data={d.invoices} empty="No invoices yet" columns={[
          { key: 'number', label: 'Invoice' },
          { key: 'period_start', label: 'Period', render: (i: any) => `${String(i.period_start).slice(0, 10)} – ${String(i.period_end).slice(0, 10)}` },
          { key: 'total', label: 'Total', render: (i: any) => <span title={i.tax_total ? `${money(i.subtotal, i.currency)} + ${money(i.tax_total, i.currency)} GST` : undefined}>{money(i.total, i.currency)}</span> },
          { key: 'status', label: 'Status', render: (i: any) => <Badge tone={i.status === 'paid' ? 'green' : i.status === 'open' ? 'yellow' : 'gray'}>{i.status}</Badge> },
          { key: 'x', label: '', render: (i: any) => (
            <span className="flex gap-3">
              <button type="button" className="text-xs text-blue-600 hover:underline" data-testid={`invoice-doc-${i.number}`} onClick={() => openInvoice(orgId, i.id)}>View</button>
              {i.status === 'open' && i.payment_url && <a className="text-xs text-blue-600 hover:underline" href={i.payment_url} target="_blank" rel="noopener noreferrer">Pay</a>}
            </span>
          ) },
        ]} />
        <BillingDetails orgId={orgId} />
      </div>
    </Card>
  );
}

export default function OrganizationsPage() {
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api.get('/organizations').then((r) => r.data as any[]) });
  const [orgId, setOrgId] = useState<string | null>(null);
  useEffect(() => { if (!orgId && orgs.data?.length) setOrgId(orgs.data[0].id); }, [orgs.data, orgId]);
  return (
    <div>
      <PageHeader title="Organizations" description="Members, roles and invitations"
        actions={orgs.data && orgs.data.length > 1
          ? <div className="w-64"><Select aria-label="Organization" value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)} options={orgs.data.map((o) => ({ value: o.id, label: `${o.name} (${o.member_role})` }))} /></div>
          : undefined} />
      {orgId ? <div className="space-y-6"><Members key={orgId} orgId={orgId} /><Billing key={`b-${orgId}`} orgId={orgId} /></div> : <p className="text-sm text-gray-500">Loading…</p>}
    </div>
  );
}
