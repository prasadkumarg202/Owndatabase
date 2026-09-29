'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import { api, formatDate } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

const EVENTS = ['insert', 'update', 'delete'] as const;
const statusTone: Record<string, any> = { delivered: 'green', failed: 'red', pending: 'yellow', sending: 'blue' };

function Deliveries({ projectId, hook, onClose }: { projectId: string; hook: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['webhook-deliveries', hook.id], queryFn: () => api.get(`/projects/${projectId}/webhooks/${hook.id}/deliveries`).then((r) => r.data as any[]), refetchInterval: 5000 });
  const retry = useMutation({
    mutationFn: (eventId: number) => api.post(`/projects/${projectId}/webhooks/${hook.id}/deliveries/${eventId}/retry`),
    onSuccess: () => { toast.success('Queued for redelivery'); qc.invalidateQueries({ queryKey: ['webhook-deliveries', hook.id] }); },
    onError: (e) => toast.error(e),
  });
  return (
    <Modal open onClose={onClose} title={`Deliveries — ${hook.name}`} wide>
      <DataTable testId="deliveries-table" data={list.data} empty="No deliveries yet" columns={[
        { key: 'id', label: '#' },
        { key: 'type', label: 'Event', render: (d: any) => d.payload?.type },
        { key: 'status', label: 'Status', render: (d: any) => <Badge tone={statusTone[d.status]}>{d.status}</Badge> },
        { key: 'attempts', label: 'Attempts' },
        { key: 'last_status_code', label: 'HTTP', render: (d: any) => d.last_status_code ?? '—' },
        { key: 'last_error', label: 'Error', render: (d: any) => <span className="text-xs text-red-600">{d.last_error}</span> },
        { key: 'created_at', label: 'Created', render: (d: any) => formatDate(d.created_at) },
        { key: 'x', label: '', render: (d: any) => ['failed', 'delivered'].includes(d.status) &&
          <button aria-label="Redeliver" className="p-1 text-gray-400 hover:text-blue-600" onClick={() => retry.mutate(d.id)}><RotateCcw className="h-3.5 w-3.5" /></button> },
      ]} />
    </Modal>
  );
}

export default function WebhooksPage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const [form, setForm] = useState({ name: '', table: '', url: '', method: 'POST', secret: '', events: ['insert', 'update', 'delete'] as string[] });
  const hooks = useQuery({ queryKey: ['webhooks', id], queryFn: () => api.get(`/projects/${id}/webhooks`).then((r) => r.data as any[]), refetchInterval: 10_000 });
  const tables = useQuery({ queryKey: ['webhook-tables', id], queryFn: () => api.get(`/projects/${id}/tables`).then((r) => r.data as any[]), enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks', id] });
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${id}/webhooks`, { ...form, table: form.table || tables.data?.[0]?.name, secret: form.secret || undefined }),
    onSuccess: () => { toast.success('Webhook created'); setOpen(false); setForm({ ...form, name: '', url: '', secret: '' }); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (h: any) => api.patch(`/projects/${id}/webhooks/${h.id}`, { enabled: !h.enabled }), onSuccess: refresh, onError: (e) => toast.error(e) });
  const del = useMutation({ mutationFn: (h: any) => api.delete(`/projects/${id}/webhooks/${h.id}`), onSuccess: () => { toast.success('Webhook deleted'); refresh(); } });

  return (
    <div>
      <PageHeader title="Database webhooks" description="Send an HTTP request when rows are inserted, updated or deleted. Retries with backoff; signed with your secret."
        actions={<Button onClick={() => setOpen(true)} data-testid="new-webhook"><Plus className="h-4 w-4" />New webhook</Button>} />
      <DataTable testId="webhooks-table" data={hooks.data} empty="No webhooks" columns={[
        { key: 'name', label: 'Name', render: (h: any) => <button className="font-medium text-blue-700 hover:underline" onClick={() => setViewing(h)}>{h.name}</button> },
        { key: 'table_name', label: 'Table', render: (h: any) => <span>{h.table_name}{!h.table_exists ? <Badge tone="red" className="ml-2">table missing</Badge> : !h.trigger_installed ? <Badge tone="yellow" className="ml-2">trigger missing — save to repair</Badge> : null}</span> },
        { key: 'events', label: 'Events', render: (h: any) => h.events.join(', ') },
        { key: 'url', label: 'URL', render: (h: any) => <code className="text-xs">{h.http_method} {h.url}</code> },
        { key: 'enabled', label: 'Status', render: (h: any) => <button onClick={() => toggle.mutate(h)}>{h.enabled ? <Badge tone="green">enabled</Badge> : <Badge>paused</Badge>}</button> },
        { key: 'pending', label: 'Queued' },
        { key: 'failed_24h', label: 'Failed 24h', render: (h: any) => h.failed_24h ? <Badge tone="red">{h.failed_24h}</Badge> : 0 },
        { key: 'last_delivered_at', label: 'Last delivery', render: (h: any) => formatDate(h.last_delivered_at) },
        { key: 'x', label: '', render: (h: any) => <button aria-label="Delete" className="p-1 text-gray-400 hover:text-red-600" onClick={() => { if (confirm(`Delete ${h.name}?`)) del.mutate(h); }}><Trash2 className="h-3.5 w-3.5" /></button> },
      ]} />
      <Card className="mt-6" title="Payload">
        <pre className="overflow-x-auto text-xs text-gray-700">{`{ "type": "INSERT" | "UPDATE" | "DELETE", "table": "orders", "schema": "…",
  "record": { … } | null, "old_record": { … } | null, "commit_timestamp": "…" }

With a secret: x-odb-timestamp and x-odb-signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")`}</pre>
      </Card>
      {viewing && <Deliveries projectId={id} hook={viewing} onClose={() => setViewing(null)} />}
      <Modal open={open} onClose={() => setOpen(false)} title="New database webhook"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} data-testid="create-webhook">Create</Button></>}>
        <div className="space-y-3">
          <ErrorBox error={create.error} />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="notify-orders" />
          <Select label="Table" value={form.table || tables.data?.[0]?.name || ''} onChange={(e) => setForm({ ...form, table: e.target.value })}
            options={(tables.data ?? []).map((t) => t.name)} />
          <fieldset className="flex gap-4 text-sm">
            <legend className="mb-1 text-xs font-medium text-gray-700">Events</legend>
            {EVENTS.map((ev) => (
              <label key={ev} className="flex items-center gap-1.5"><input type="checkbox" checked={form.events.includes(ev)}
                onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })} />{ev}</label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <div className="w-28"><Select label="Method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} options={['POST', 'PUT', 'PATCH']} /></div>
            <div className="flex-1"><Input label="URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com/hooks/orders" /></div>
          </div>
          <Input label="Signing secret (optional)" type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} hint="At least 8 characters" />
        </div>
      </Modal>
    </div>
  );
}
