'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Tabs } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { TableBrowser } from '@/components/database/TableBrowser';
import { TableStructure } from '@/components/database/TableStructure';

const TEMPLATES: Record<string, { command: string; roles: string[]; using: string; with_check: string }> = {
  'Owner can do everything (user_id = auth.uid())': { command: 'ALL', roles: ['authenticated'], using: 'user_id = auth.uid()', with_check: 'user_id = auth.uid()' },
  'Everyone can read': { command: 'SELECT', roles: ['anon', 'authenticated'], using: 'true', with_check: '' },
  'Signed-in users can read': { command: 'SELECT', roles: ['authenticated'], using: 'true', with_check: '' },
  'Signed-in users can insert their own rows': { command: 'INSERT', roles: ['authenticated'], using: '', with_check: 'user_id = auth.uid()' },
};

function Policies({ projectId, table, info }: { projectId: string; table: string; info: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', command: 'ALL', roles: 'authenticated', using: '', with_check: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['table', projectId, table] }); qc.invalidateQueries({ queryKey: ['tables', projectId] }); };
  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/policies`, {
      table, name: form.name, command: form.command, roles: form.roles.split(',').map((r) => r.trim()).filter(Boolean),
      using: form.using || null, with_check: form.with_check || null,
    }),
    onSuccess: () => { toast.success('Policy created'); setForm({ ...form, name: '' }); refresh(); },
  });
  const drop = useMutation({ mutationFn: (name: string) => api.delete(`/projects/${projectId}/policies/${table}/${encodeURIComponent(name)}`), onSuccess: () => { toast.success('Policy dropped'); refresh(); }, onError: (e) => toast.error(e) });
  const toggle = useMutation({ mutationFn: () => api.patch(`/projects/${projectId}/tables/${table}`, { action: info.rls_enabled ? 'disable_rls' : 'enable_rls' }), onSuccess: refresh, onError: (e) => toast.error(e) });

  return (
    <div className="space-y-6">
      <Card title="Row Level Security" actions={<Button size="sm" variant={info.rls_enabled ? 'secondary' : 'primary'} onClick={() => toggle.mutate()} loading={toggle.isPending} data-testid="toggle-rls">{info.rls_enabled ? 'Disable RLS' : 'Enable RLS'}</Button>}>
        <p className="text-sm text-gray-600">
          RLS is <Badge tone={info.rls_enabled ? 'green' : 'yellow'}>{info.rls_enabled ? 'enabled' : 'disabled'}</Badge>.
          {info.rls_enabled
            ? ' Only rows allowed by a policy are visible through the API (service_role keys bypass RLS).'
            : ' Anyone with the anon key can read and write every row through the REST API. Enable RLS and add policies before going to production.'}
        </p>
      </Card>
      <Card title="Policies" bodyClassName="p-0">
        <DataTable data={info.policies} testId="policies-table" empty="No policies" columns={[
          { key: 'name', label: 'Name' }, { key: 'command', label: 'Command' },
          { key: 'roles', label: 'Roles', render: (p: any) => p.roles.join(', ') },
          { key: 'using', label: 'USING', render: (p: any) => <span className="font-mono text-xs">{p.using}</span> },
          { key: 'with_check', label: 'WITH CHECK', render: (p: any) => <span className="font-mono text-xs">{p.with_check}</span> },
          { key: 'x', label: '', render: (p: any) => <button aria-label="Drop policy" className="p-1 text-gray-400 hover:text-red-600" onClick={() => drop.mutate(p.name)}><Trash2 className="h-3.5 w-3.5" /></button> },
        ]} />
      </Card>
      <Card title="New policy">
        <div className="grid gap-3 md:grid-cols-2">
          <Select label="Template" value="" onChange={(e) => { const t = TEMPLATES[e.target.value]; if (t) setForm({ ...form, ...t, roles: t.roles.join(', '), name: form.name || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) }); }}
            options={[{ value: '', label: 'Start from a template…' }, ...Object.keys(TEMPLATES)]} />
          <Input label="Policy name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select label="Command" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} options={['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']} />
          <Input label="Roles (comma separated)" value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} hint="anon, authenticated, service_role" />
          <Input label="USING expression" value={form.using} onChange={(e) => setForm({ ...form, using: e.target.value })} placeholder="user_id = auth.uid()" />
          <Input label="WITH CHECK expression" value={form.with_check} onChange={(e) => setForm({ ...form, with_check: e.target.value })} />
        </div>
        <div className="mt-3 flex items-center gap-3"><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name} data-testid="create-policy">Create policy</Button><ErrorBox error={create.error} /></div>
      </Card>
    </div>
  );
}

export default function TablePage() {
  const id = useProjectId();
  const name = useSearchParams().get('name') ?? '';
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('data');
  const { data, error, isLoading } = useQuery({ queryKey: ['table', id, name], queryFn: () => api.get(`/projects/${id}/tables/${encodeURIComponent(name)}`).then((r) => r.data), enabled: !!name });
  const realtime = useMutation({
    mutationFn: () => api.post(`/projects/${id}/tables/${name}/realtime`, { enabled: !data?.realtime_enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['table', id, name] }),
  });
  const drop = useMutation({
    mutationFn: () => api.delete(`/projects/${id}/tables/${name}?confirm=true`),
    onSuccess: () => { toast.success(`Table ${name} dropped`); qc.invalidateQueries({ queryKey: ['tables', id] }); router.push(`/projects/${id}/database`); },
    onError: (e) => toast.error(e),
  });

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (error || !data) return <ErrorBox error={error ?? new Error('Table not found')} />;

  return (
    <div>
      <PageHeader
        title={<span className="font-mono">{name}</span>}
        description={<><Link className="text-blue-600 hover:underline" href={`/projects/${id}/database`}>Tables</Link> / {data.schema}.{name}</>}
        actions={<>
          <Button variant="secondary" size="sm" onClick={() => realtime.mutate()} loading={realtime.isPending} data-testid="toggle-realtime">Realtime: {data.realtime_enabled ? 'on' : 'off'}</Button>
          <Button variant="danger" size="sm" onClick={() => { if (prompt(`Type ${name} to drop this table and all its data`) === name) drop.mutate(); }}>Drop table</Button>
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'data', label: 'Data' }, { id: 'structure', label: 'Structure' }, { id: 'policies', label: `Policies (${data.policies.length})` }]} />
      {tab === 'data' && <TableBrowser projectId={id} table={name} columns={data.columns} />}
      {tab === 'structure' && <TableStructure projectId={id} table={name} info={data} />}
      {tab === 'policies' && <Policies projectId={id} table={name} info={data} />}
    </div>
  );
}
