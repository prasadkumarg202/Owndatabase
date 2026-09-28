'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Play } from 'lucide-react';
import { api, formatDate } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

const PRESETS = [
  { value: '*/5 * * * *', label: 'Every 5 minutes' }, { value: '@hourly', label: 'Every hour' },
  { value: '0 2 * * *', label: 'Every day at 02:00 UTC' }, { value: '0 9 * * 1', label: 'Every Monday 09:00 UTC' },
  { value: '@monthly', label: 'First day of every month' }, { value: 'custom', label: 'Custom…' },
];

export default function CronPage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState('@hourly');
  const [form, setForm] = useState({ name: '', schedule: '@hourly', job_type: 'function.invoke', payload: '{"slug": "hello"}' });
  const list = useQuery({ queryKey: ['cron', id], queryFn: () => api.get(`/projects/${id}/cron`).then((r) => r.data as any[]), refetchInterval: 10_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['cron', id] });
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${id}/cron`, { ...form, payload: JSON.parse(form.payload || '{}') }),
    onSuccess: () => { toast.success('Cron job created'); setOpen(false); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (c: any) => api.patch(`/projects/${id}/cron/${c.id}`, { is_enabled: !c.is_enabled }), onSuccess: refresh });
  const del = useMutation({ mutationFn: (c: any) => api.delete(`/projects/${id}/cron/${c.id}`), onSuccess: () => { toast.success('Deleted'); refresh(); } });
  const run = useMutation({ mutationFn: (c: any) => api.post(`/projects/${id}/cron/${c.id}/run`), onSuccess: (r) => { toast.success(`Queued job ${r.job_id}`); refresh(); } });

  return (
    <div>
      <PageHeader title="Cron jobs" description="Run queue jobs on a schedule (times are UTC)."
        actions={<Button onClick={() => setOpen(true)} data-testid="new-cron"><Plus className="h-4 w-4" />New cron job</Button>} />
      <DataTable testId="cron-table" data={list.data} empty="No cron jobs" columns={[
        { key: 'name', label: 'Name', render: (c: any) => <span className="font-medium">{c.name}</span> },
        { key: 'schedule', label: 'Schedule', render: (c: any) => <code className="text-xs">{c.schedule}</code> },
        { key: 'job_type', label: 'Job' },
        { key: 'is_enabled', label: 'Status', render: (c: any) => <button onClick={() => toggle.mutate(c)}>{c.is_enabled ? <Badge tone="green">enabled</Badge> : <Badge>paused</Badge>}</button> },
        { key: 'last_run_at', label: 'Last run', render: (c: any) => formatDate(c.last_run_at) },
        { key: 'next_run_at', label: 'Next run', render: (c: any) => formatDate(c.next_run_at) },
        { key: 'run_count', label: 'Runs' },
        { key: 'x', label: '', render: (c: any) => <div className="flex justify-end gap-1">
          <button aria-label="Run now" className="p-1 text-gray-400 hover:text-blue-600" onClick={() => run.mutate(c)}><Play className="h-3.5 w-3.5" /></button>
          <button aria-label="Delete" className="p-1 text-gray-400 hover:text-red-600" onClick={() => { if (confirm(`Delete ${c.name}?`)) del.mutate(c); }}><Trash2 className="h-3.5 w-3.5" /></button>
        </div> },
      ]} />
      <Modal open={open} onClose={() => setOpen(false)} title="New cron job"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => { try { JSON.parse(form.payload || '{}'); create.mutate(); } catch { toast.error('Payload must be JSON'); } }} loading={create.isPending} data-testid="create-cron">Create</Button></>}>
        <div className="space-y-3">
          <ErrorBox error={create.error} />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="nightly-cleanup" />
          <Select label="Schedule" value={preset} onChange={(e) => { setPreset(e.target.value); if (e.target.value !== 'custom') setForm({ ...form, schedule: e.target.value }); }} options={PRESETS} />
          {preset === 'custom' && <Input label="Cron expression" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} hint="minute hour day month weekday, e.g. 30 3 * * *" />}
          <Select label="Job type" value={form.job_type} onChange={(e) => setForm({ ...form, job_type: e.target.value })} options={['function.invoke', 'webhook.dispatch', 'email.send', 'sql.run', 'noop']} />
          <Textarea label="Payload (JSON)" rows={4} value={form.payload} onChange={(e) => setForm({ ...form, payload: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
