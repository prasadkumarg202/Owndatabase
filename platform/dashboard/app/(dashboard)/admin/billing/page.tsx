'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '@/lib/api';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

const money = (minor: number, currency: string) => `${(Number(minor) / 100).toFixed(2)} ${String(currency).toUpperCase()}`;

/** Platform administrators: billing switch, GST seller details, plans, organizations and invoices (docs/billing.md). */
export default function AdminBillingPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/billing/plans') });
  const gst = useQuery({ queryKey: ['admin-gst'], queryFn: () => api.get('/admin/billing/gst'), retry: false });
  const enabled = !!plans.data?.enabled;
  const orgs = useQuery({ queryKey: ['admin-orgs'], queryFn: () => api.get('/admin/billing/organizations').then((r: any) => r.data as any[]), enabled, retry: false });
  const [status, setStatus] = useState('');
  const invoices = useQuery({ queryKey: ['admin-invoices', status], queryFn: () => api.get(`/admin/billing/invoices${status ? `?status=${status}` : ''}`).then((r: any) => r.data as any[]), enabled, retry: false });
  const refresh = () => qc.invalidateQueries();
  const call = useMutation({
    mutationFn: ({ method, path, body }: { method: 'put' | 'post'; path: string; body?: any }) => api[method](path, body),
    onSuccess: (_r, v) => { toast.success('Saved'); if (v.path !== '/admin/billing/gst') refresh(); else gst.refetch(); },
    onError: (e) => toast.error(e),
  });
  const [g, setG] = useState<any>(null);
  useEffect(() => { if (gst.data?.gst && !g) setG({ sac_code: '998315', rate: 18, ...gst.data.gst }); }, [gst.data, g]);
  const [period, setPeriod] = useState(new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 7));

  if (gst.error) return <div><PageHeader title="Billing administration" /><ErrorBox error={gst.error} /></div>;
  return (
    <div className="space-y-6">
      <PageHeader title="Billing administration" description="Platform administrators only." />
      <Card title="Billing" actions={<Button size="sm" variant={enabled ? 'danger' : 'primary'} onClick={() => call.mutate({ method: 'put', path: '/admin/billing/settings', body: { enabled: !enabled } })} data-testid="toggle-billing">{enabled ? 'Turn billing off' : 'Turn billing on'}</Button>}>
        <p className="text-sm">Billing is <strong>{enabled ? 'on' : 'off'}</strong>. {enabled ? 'Plans limit projects; invoices are issued monthly.' : 'Everyone has the default limits and no invoices are issued.'}</p>
      </Card>
      {g && (
        <Card title="GST (India)" description="Your company's details on tax invoices. The state comes from the GSTIN.">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!g.enabled} onChange={(e) => setG({ ...g, enabled: e.target.checked })} />Issue GST tax invoices</label>
            <Input label="Legal name" value={g.legal_name ?? ''} onChange={(e) => setG({ ...g, legal_name: e.target.value })} />
            <Input label="GSTIN" value={g.gstin ?? ''} onChange={(e) => setG({ ...g, gstin: e.target.value.toUpperCase() })} />
            <Input label="Address" value={g.address ?? ''} onChange={(e) => setG({ ...g, address: e.target.value })} />
            <Input label="Billing email" value={g.email ?? ''} onChange={(e) => setG({ ...g, email: e.target.value })} />
            <Input label="SAC code" value={g.sac_code ?? ''} onChange={(e) => setG({ ...g, sac_code: e.target.value })} />
            <Input label="GST rate (%)" type="number" value={g.rate ?? 18} onChange={(e) => setG({ ...g, rate: Number(e.target.value) })} />
            <Input label="LUT number (exports)" value={g.lut_number ?? ''} onChange={(e) => setG({ ...g, lut_number: e.target.value })} />
          </div>
          <Button className="mt-3" size="sm" onClick={() => call.mutate({ method: 'put', path: '/admin/billing/gst', body: {
            enabled: !!g.enabled, legal_name: g.legal_name, gstin: g.gstin, address: g.address, sac_code: g.sac_code, rate: Number(g.rate),
            ...(g.email ? { email: g.email } : {}), ...(g.lut_number ? { lut_number: g.lut_number } : {}),
          } })} data-testid="save-gst">Save GST details</Button>
        </Card>
      )}
      {enabled && <>
        <Card title="Plans" bodyClassName="p-0">
          <DataTable data={plans.data?.data} columns={[
            { key: 'name', label: 'Plan' },
            { key: 'price_monthly', label: 'Price / month', render: (p: any) => money(p.price_monthly, p.currency) },
            { key: 'max_projects', label: 'Projects', render: (p: any) => p.max_projects ?? 'unlimited' },
          ]} />
        </Card>
        <Card title="Organizations" bodyClassName="p-0">
          <ErrorBox error={orgs.error} />
          <DataTable testId="admin-orgs" data={orgs.data} empty="No organizations" columns={[
            { key: 'name', label: 'Organization' },
            { key: 'projects', label: 'Projects' },
            { key: 'plan_id', label: 'Plan', render: (o: any) => (
              <select aria-label={`Plan of ${o.name}`} className="rounded border border-gray-300 px-2 py-1 text-xs" value={o.plan_id}
                onChange={(e) => call.mutate({ method: 'put', path: `/admin/billing/organizations/${o.id}/plan`, body: { plan_id: e.target.value } })}>
                {(plans.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>) },
            { key: 'status', label: 'Status', render: (o: any) => <Badge tone={o.status === 'active' ? 'green' : 'red'}>{o.status}</Badge> },
          ]} />
        </Card>
        <Card title="Invoices" actions={<div className="flex items-center gap-2">
          <input aria-label="Period" type="month" className="rounded border border-gray-300 px-2 py-1 text-xs" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <Button size="sm" variant="secondary" onClick={() => call.mutate({ method: 'post', path: '/admin/billing/invoices/generate', body: { period } })}>Generate for period</Button>
          <select aria-label="Status filter" className="rounded border border-gray-300 px-2 py-1 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option><option value="open">open</option><option value="paid">paid</option><option value="void">void</option>
          </select>
        </div>} bodyClassName="p-0">
          <DataTable testId="admin-invoices" data={invoices.data} empty="No invoices" columns={[
            { key: 'number', label: 'Invoice' },
            { key: 'organization_name', label: 'Organization' },
            { key: 'issued_at', label: 'Issued', render: (i: any) => formatDate(i.issued_at, false) },
            { key: 'total', label: 'Total', render: (i: any) => money(i.total, i.currency) },
            { key: 'status', label: 'Status', render: (i: any) => <Badge tone={i.status === 'paid' ? 'green' : i.status === 'open' ? 'yellow' : 'gray'}>{i.status}</Badge> },
            { key: 'x', label: '', render: (i: any) => (
              <span className="flex gap-2">
                <button type="button" className="text-xs text-blue-600 hover:underline" onClick={async () => {
                  const html = await api.get(`/admin/billing/invoices/${i.id}/document`);
                  window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank', 'noopener');
                }}>View</button>
                {i.status === 'open' && <>
                  <button type="button" className="text-xs text-green-700 hover:underline" onClick={() => call.mutate({ method: 'post', path: `/admin/billing/invoices/${i.id}/mark-paid` })}>Mark paid</button>
                  <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => call.mutate({ method: 'post', path: `/admin/billing/invoices/${i.id}/void` })}>Void</button>
                </>}
              </span>) },
          ]} />
        </Card>
      </>}
    </div>
  );
}
