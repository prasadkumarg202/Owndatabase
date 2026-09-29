'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, formatBytes, formatDate, timeAgo } from '@/lib/api';
import { useProject, useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Tabs } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { CopyField } from '@/components/ui/CopyField';
import { useToast } from '@/components/ui/Toast';

function Domains({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState('');
  const list = useQuery({ queryKey: ['domains', id], queryFn: () => api.get(`/projects/${id}/domains`).then((r) => r.data as any[]) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['domains', id] });
  const add = useMutation({ mutationFn: () => api.post(`/projects/${id}/domains`, { hostname: host }), onSuccess: () => { setHost(''); refresh(); } });
  const verify = useMutation({
    mutationFn: (d: string) => api.post(`/projects/${id}/domains/${d}/verify`),
    onSuccess: (r) => { r.status === 'verified' ? toast.success(`${r.hostname} verified`) : toast.error(r.last_error ?? 'Not verified yet'); refresh(); },
  });
  const remove = useMutation({ mutationFn: (d: string) => api.delete(`/projects/${id}/domains/${d}`), onSuccess: () => { toast.success('Domain removed'); refresh(); } });
  return (
    <Card title="Custom domains" description="Serve this project's APIs from your own hostname, e.g. api.example.com/rest/v1/… — HTTPS certificates are issued automatically once verified.">
      <form className="mb-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div className="w-80"><Input label="Hostname" value={host} onChange={(e) => setHost(e.target.value)} placeholder="api.example.com" /></div>
        <Button type="submit" loading={add.isPending} disabled={!host} data-testid="add-domain">Add domain</Button>
      </form>
      <ErrorBox error={add.error} />
      <div className="space-y-4" data-testid="domains-list">
        {list.data?.length === 0 && <p className="text-sm text-gray-500">No custom domains.</p>}
        {list.data?.map((d) => (
          <div key={d.id} className="rounded-md border border-gray-200 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><span className="font-medium">{d.hostname}</span><Badge tone={d.status === 'verified' ? 'green' : 'yellow'}>{d.status}</Badge></div>
              <div className="flex gap-1">
                {d.status !== 'verified' && <Button size="sm" variant="secondary" onClick={() => verify.mutate(d.id)} loading={verify.isPending}>Verify</Button>}
                <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Remove ${d.hostname}?`)) remove.mutate(d.id); }}>Remove</Button>
              </div>
            </div>
            {d.status !== 'verified' && (
              <div className="mt-2 text-xs">
                <p className="mb-1 text-gray-600">Create these DNS records, then click Verify:</p>
                <table className="w-full font-mono"><tbody>
                  {d.dns_records.map((r: any) => <tr key={r.type}><td className="pr-3">{r.type}</td><td className="pr-3">{r.name}</td><td className="break-all">{r.value}</td></tr>)}
                </tbody></table>
                {d.last_error && <p className="mt-1 text-amber-700">{d.last_error}</p>}
              </div>
            )}
            {d.status === 'verified' && <div className="mt-2"><CopyField label="REST URL" value={d.endpoints.rest_url} /></div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function General({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const { data: p } = useProject(id);
  const [name, setName] = useState('');
  useEffect(() => { if (p) setName(p.name); }, [p]);
  const save = useMutation({ mutationFn: () => api.patch(`/projects/${id}`, { name }), onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['project', id] }); qc.invalidateQueries({ queryKey: ['projects'] }); } });
  const pause = useMutation({ mutationFn: (a: string) => api.post(`/projects/${id}/${a}`), onSuccess: (r) => { toast.success(`Project ${r.status}`); qc.invalidateQueries({ queryKey: ['project', id] }); qc.invalidateQueries({ queryKey: ['projects'] }); } });
  const del = useMutation({ mutationFn: () => api.delete(`/projects/${id}?confirm=${p.slug}`), onSuccess: () => { toast.success('Project deleted'); qc.invalidateQueries({ queryKey: ['projects'] }); router.push('/projects'); }, onError: (e) => toast.error(e) });
  if (!p) return null;
  return (
    <div className="space-y-6">
      <Card title="General">
        <div className="grid gap-3 md:grid-cols-2">
          <Input label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Slug" value={p.slug} disabled />
          <Input label="Project ID" value={p.id} disabled />
          <Input label="Database schema" value={p.db_schema} disabled />
        </div>
        <Button className="mt-3" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>
      </Card>
      <Domains id={id} />
      <Card title="Danger zone" className="border-red-200">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-3">
          <div><p className="text-sm font-medium">{p.status === 'paused' ? 'Resume project' : 'Pause project'}</p><p className="text-xs text-gray-500">Paused projects reject all REST, auth, storage and realtime requests.</p></div>
          <Button variant="secondary" onClick={() => pause.mutate(p.status === 'paused' ? 'resume' : 'pause')} data-testid="pause-project">{p.status === 'paused' ? 'Resume' : 'Pause'}</Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <div><p className="text-sm font-medium text-red-700">Delete project</p><p className="text-xs text-gray-500">Deletes the schema, users, files metadata and keys. This cannot be undone.</p></div>
          <Button variant="danger" onClick={() => { if (prompt(`Type ${p.slug} to delete this project`) === p.slug) del.mutate(); }}>Delete project</Button>
        </div>
      </Card>
    </div>
  );
}

function Keys({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'anon' });
  const [created, setCreated] = useState<any>(null);
  const keys = useQuery({ queryKey: ['keys', id], queryFn: () => api.get(`/keys?project_id=${id}`).then((r) => r.data as any[]) });
  const create = useMutation({ mutationFn: () => api.post('/keys', { project_id: id, ...form }), onSuccess: (r) => { setCreated(r); setOpen(false); qc.invalidateQueries({ queryKey: ['keys', id] }); } });
  const revoke = useMutation({ mutationFn: (k: string) => api.delete(`/keys/${k}`), onSuccess: () => { toast.success('Key revoked'); qc.invalidateQueries({ queryKey: ['keys', id] }); } });
  const [rotating, setRotating] = useState<any>(null);
  const [grace, setGrace] = useState('3600');
  const rotate = useMutation({
    mutationFn: () => api.post(`/keys/${rotating.id}/rotate`, { grace_period_seconds: Number(grace) }),
    onSuccess: (r) => { setRotating(null); setCreated(r); qc.invalidateQueries({ queryKey: ['keys', id] }); },
  });
  const [editing, setEditing] = useState<any>(null);
  const [limits, setLimits] = useState({ rate: '', ips: '' });
  const openEdit = (k: any) => { setEditing(k); setLimits({ rate: k.rate_limit_per_minute ? String(k.rate_limit_per_minute) : '', ips: (k.allowed_ips ?? []).join('\n') }); };
  const saveLimits = useMutation({
    mutationFn: () => api.patch(`/keys/${editing.id}`, {
      rate_limit_per_minute: limits.rate.trim() ? Number(limits.rate) : null,
      allowed_ips: limits.ips.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
    }),
    onSuccess: () => { toast.success('Key limits saved'); setEditing(null); qc.invalidateQueries({ queryKey: ['keys', id] }); },
  });
  const status = (k: any) => !k.is_active ? <Badge tone="red">revoked</Badge>
    : !k.usable ? <Badge tone="red">expired</Badge>
    : k.rotated_at ? <Badge tone="yellow">rotating — until {formatDate(k.expires_at)}</Badge>
    : <Badge tone="green">active</Badge>;
  return (
    <Card title="API keys" description="anon keys are safe in browsers (RLS applies). service_role keys bypass RLS — keep them on servers."
      actions={<Button size="sm" onClick={() => setOpen(true)} data-testid="new-key"><Plus className="h-3.5 w-3.5" />New key</Button>} bodyClassName="p-0">
      <DataTable testId="keys-table" data={keys.data} columns={[
        { key: 'name', label: 'Name' }, { key: 'type', label: 'Type', render: (k: any) => <Badge tone={k.type === 'anon' ? 'blue' : 'purple'}>{k.type}</Badge> },
        { key: 'key_prefix', label: 'Key', render: (k: any) => <code className="text-xs">{k.key_prefix}…</code> },
        { key: 'is_active', label: 'Status', render: status },
        { key: 'limits', label: 'Limits', render: (k: any) => <span className="text-xs text-gray-600">
          {k.rate_limit_per_minute ? `${k.rate_limit_per_minute}/min` : 'default rate'}{k.allowed_ips?.length ? ` · ${k.allowed_ips.length} IP rule${k.allowed_ips.length > 1 ? 's' : ''}` : ''}</span> },
        { key: 'last_used_at', label: 'Last used', render: (k: any) => timeAgo(k.last_used_at) },
        { key: 'created_at', label: 'Created', render: (k: any) => formatDate(k.created_at, false) },
        { key: 'x', label: '', render: (k: any) => k.usable && <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => openEdit(k)} aria-label={`Limits for ${k.name}`}>Limits</Button>
          {!k.rotated_at && <Button size="sm" variant="ghost" onClick={() => setRotating(k)} aria-label={`Rotate ${k.name}`}>Rotate</Button>}
          <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Revoke ${k.name}? Apps using it stop working.`)) revoke.mutate(k.id); }}>Revoke</Button>
        </div> },
      ]} />
      <Modal open={open} onClose={() => setOpen(false)} title="Create API key"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name} data-testid="create-key">Create</Button></>}>
        <div className="space-y-3">
          <ErrorBox error={create.error} />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mobile app" />
          <Select label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={[{ value: 'anon', label: 'anon — public, RLS applies' }, { value: 'service_role', label: 'service_role — server only, bypasses RLS' }]} />
        </div>
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Limits for ${editing?.name ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => saveLimits.mutate()} loading={saveLimits.isPending} data-testid="save-key-limits">Save</Button></>}>
        <div className="space-y-3">
          <ErrorBox error={saveLimits.error} />
          <Input label="Requests per minute (all clients of this key)" type="number" min={1} value={limits.rate} onChange={(e) => setLimits({ ...limits, rate: e.target.value })} placeholder="default" hint="Empty: only the per-client default applies" />
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="key-ips">Allowed IPs / CIDR ranges (one per line)</label>
            <textarea id="key-ips" rows={4} className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs" value={limits.ips} onChange={(e) => setLimits({ ...limits, ips: e.target.value })} placeholder={'203.0.113.7\n10.0.0.0/8'} />
            <p className="text-xs text-gray-500">Empty: any address. Requests from elsewhere get 403.</p>
          </div>
        </div>
      </Modal>
      <Modal open={!!rotating} onClose={() => setRotating(null)} title={`Rotate ${rotating?.name ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setRotating(null)}>Cancel</Button><Button onClick={() => rotate.mutate()} loading={rotate.isPending} data-testid="confirm-rotate">Rotate key</Button></>}>
        <div className="space-y-3 text-sm">
          <ErrorBox error={rotate.error} />
          <p>A new {rotating?.type} key replaces this one. Deploy it to your apps; the old key keeps working until the grace period ends.</p>
          <Select label="Old key stops working" value={grace} onChange={(e) => setGrace(e.target.value)} options={[
            { value: '0', label: 'Immediately (key leaked)' }, { value: '900', label: 'In 15 minutes' }, { value: '3600', label: 'In 1 hour' },
            { value: '86400', label: 'In 24 hours' }, { value: '604800', label: 'In 7 days' }]} />
        </div>
      </Modal>
      <Modal open={!!created} onClose={() => setCreated(null)} title={created?.rotated_from ? 'Key rotated' : 'Key created'}>
        {created && <div className="space-y-2">
          <p className="text-sm text-amber-700">Copy this key now. It will not be shown again.</p>
          <CopyField value={created.key} testId="new-key-value" />
          {created.previous_key && <p className="text-xs text-gray-500">{created.previous_key.revoked ? 'The old key was revoked.' : `The old key (${created.previous_key.key_prefix}…) works until ${formatDate(created.previous_key.expires_at)}.`}</p>}
        </div>}
      </Modal>
    </Card>
  );
}

function Secrets({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', value: '' });
  const secrets = useQuery({ queryKey: ['secrets', id], queryFn: () => api.get(`/secrets?project_id=${id}`).then((r) => r.data as any[]) });
  const save = useMutation({ mutationFn: () => api.post('/secrets', { project_id: id, ...form }), onSuccess: (r) => { toast.success(`${r.name} saved (v${r.version})`); setForm({ name: '', value: '' }); qc.invalidateQueries({ queryKey: ['secrets', id] }); } });
  const del = useMutation({ mutationFn: (sid: string) => api.delete(`/secrets/${sid}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['secrets', id] }), onError: (e) => toast.error(e) });
  return (
    <Card title="Secrets" description="Encrypted with AES-256-GCM. Functions read them from req.env. Values can never be viewed again." bodyClassName="p-0">
      <DataTable testId="secrets-table" data={secrets.data} empty="No secrets" columns={[
        { key: 'name', label: 'Name', render: (s: any) => <code>{s.name}</code> }, { key: 'version', label: 'Version' },
        { key: 'updated_at', label: 'Updated', render: (s: any) => formatDate(s.updated_at) },
        { key: 'x', label: '', render: (s: any) => <button aria-label="Delete secret" className="p-1 text-gray-400 hover:text-red-600" onClick={() => del.mutate(s.id)}><Trash2 className="h-3.5 w-3.5" /></button> },
      ]} />
      <form className="flex flex-wrap items-end gap-2 border-t border-gray-200 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="w-56"><Input label="Name" placeholder="STRIPE_KEY" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })} /></div>
        <div className="w-72"><Input label="Value" type="password" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></div>
        <Button type="submit" disabled={!form.name || !form.value} loading={save.isPending} data-testid="save-secret">Save secret</Button>
        <ErrorBox error={save.error} />
      </form>
    </Card>
  );
}

function DatabaseSettings({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const conn = useQuery({ queryKey: ['connection', id], queryFn: () => api.get(`/projects/${id}/connection`), enabled: reveal });
  const ext = useQuery({ queryKey: ['extensions', id], queryFn: () => api.get(`/projects/${id}/extensions`).then((r) => r.data as any[]) });
  const roles = useQuery({ queryKey: ['roles', id], queryFn: () => api.get(`/projects/${id}/roles`).then((r) => r.data as any[]) });
  const toggleExt = useMutation({
    mutationFn: (e: any) => e.installed ? api.delete(`/projects/${id}/extensions/${e.name}`) : api.post(`/projects/${id}/extensions`, { name: e.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['extensions', id] }), onError: (e) => toast.error(e),
  });
  const [role, setRole] = useState({ name: '', can_login: false, password: '' });
  const createRole = useMutation({ mutationFn: () => api.post(`/projects/${id}/roles`, { ...role, password: role.can_login ? role.password : undefined }), onSuccess: () => { toast.success('Role created'); setRole({ name: '', can_login: false, password: '' }); qc.invalidateQueries({ queryKey: ['roles', id] }); }, onError: (e) => toast.error(e) });
  const dropRole = useMutation({ mutationFn: (n: string) => api.delete(`/projects/${id}/roles/${n}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['roles', id] }), onError: (e) => toast.error(e) });
  return (
    <div className="space-y-6">
      <Card title="Direct connection" description="Connect with psql or any PostgreSQL client. This role can only access the project schema.">
        {!reveal ? <Button variant="secondary" onClick={() => setReveal(true)}>Show connection details</Button> : conn.data ? (
          <div className="space-y-2">
            <CopyField label="Connection string" value={conn.data.connection_string} secret />
            <p className="text-xs text-gray-500">{conn.data.note}</p>
          </div>
        ) : <ErrorBox error={conn.error} />}
      </Card>
      <Card title="Extensions" description="Extensions are installed database-wide (shared by all projects on this server)." bodyClassName="p-0">
        <DataTable data={ext.data} rowKey={(e: any) => e.name} columns={[
          { key: 'name', label: 'Extension', render: (e: any) => <code>{e.name}</code> }, { key: 'comment', label: 'Description' },
          { key: 'installed_version', label: 'Version' },
          { key: 'x', label: '', render: (e: any) => e.available === false ? <Badge>not available</Badge> : <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`Enable ${e.name}`} checked={e.installed} onChange={() => toggleExt.mutate(e)} />{e.installed ? 'enabled' : 'disabled'}</label> },
        ]} />
      </Card>
      <Card title="Database roles" bodyClassName="p-0">
        <DataTable data={roles.data} rowKey={(r: any) => r.name} columns={[
          { key: 'name', label: 'Role', render: (r: any) => <code>{r.name}</code> }, { key: 'kind', label: 'Kind', render: (r: any) => <Badge>{r.kind}</Badge> },
          { key: 'can_login', label: 'Login' }, { key: 'bypass_rls', label: 'Bypass RLS' },
          { key: 'x', label: '', render: (r: any) => r.kind === 'custom' && <button aria-label="Drop role" className="p-1 text-gray-400 hover:text-red-600" onClick={() => dropRole.mutate(r.name)}><Trash2 className="h-3.5 w-3.5" /></button> },
        ]} />
        <form className="flex flex-wrap items-end gap-2 border-t border-gray-200 p-3" onSubmit={(e) => { e.preventDefault(); createRole.mutate(); }}>
          <div className="w-48"><Input label="New role name" placeholder="readonly" value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value.toLowerCase() })} /></div>
          <label className="mb-2 flex items-center gap-1 text-xs"><input type="checkbox" checked={role.can_login} onChange={(e) => setRole({ ...role, can_login: e.target.checked })} />Can log in</label>
          {role.can_login && <div className="w-56"><Input label="Password (12+ chars)" type="password" value={role.password} onChange={(e) => setRole({ ...role, password: e.target.value })} /></div>}
          <Button type="submit" size="sm" disabled={!role.name}>Create read-only role</Button>
        </form>
      </Card>
    </div>
  );
}

const LIMITS: { key: string; label: string; bytes?: boolean }[] = [
  { key: 'api_requests_per_day', label: 'API requests today' },
  { key: 'function_invocations_per_day', label: 'Function invocations today' },
  { key: 'database_bytes', label: 'Database size', bytes: true },
  { key: 'storage_bytes', label: 'Storage', bytes: true },
  { key: 'auth_users', label: 'Auth users' },
  { key: 'realtime_connections', label: 'Realtime connections (concurrent)' },
];

function Usage({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const data = useQuery({ queryKey: ['limits', id], queryFn: () => api.get(`/projects/${id}/limits`), refetchInterval: 30_000 });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get('/auth/me') });
  const [edit, setEdit] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data.data) setEdit(Object.fromEntries(LIMITS.map((l) => [l.key, data.data.limits[l.key] === null ? '' : String(data.data.limits[l.key])])));
  }, [data.data]);
  const save = useMutation({
    mutationFn: () => api.put(`/projects/${id}/limits`, Object.fromEntries(LIMITS.map((l) => [l.key, edit[l.key]?.trim() ? Number(edit[l.key]) : null]))),
    onSuccess: () => { toast.success('Limits saved'); qc.invalidateQueries({ queryKey: ['limits', id] }); },
  });
  const fmt = (v: number | null | undefined, bytes?: boolean) => (v === null || v === undefined ? '—' : bytes ? formatBytes(v) : v.toLocaleString());
  const d = data.data;
  return (
    <div className="space-y-6">
      {d?.read_only && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" data-testid="read-only-banner">
          This project is over its database size limit and is <strong>read-only</strong>: inserts and updates are refused. Delete data or ask a platform admin for a higher limit.
        </div>
      )}
      <Card title="Usage & limits" description="Limits are set by platform administrators. Daily counters reset at 00:00 UTC.">
        <div className="space-y-4" data-testid="usage-limits">
          {LIMITS.map((l) => {
            const used = d?.usage?.[l.key] ?? null;
            const max = d?.limits?.[l.key] ?? null;
            const pct = used !== null && max ? Math.min(100, Math.round((used / max) * 100)) : null;
            return (
              <div key={l.key}>
                <div className="flex justify-between text-sm"><span className="text-gray-700">{l.label}</span>
                  <span className="text-gray-500">{fmt(used, l.bytes)} / {max === null ? 'unlimited' : fmt(max, l.bytes)}</span></div>
                {pct !== null && <div className="mt-1 h-1.5 rounded bg-gray-100"><div className={`h-1.5 rounded ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} /></div>}
              </div>
            );
          })}
        </div>
      </Card>
      {me.data?.is_platform_admin && (
        <Card title="Edit limits" description="Platform admin only. Leave empty for unlimited; sizes in bytes.">
          <div className="grid gap-3 md:grid-cols-2">
            {LIMITS.map((l) => <Input key={l.key} label={l.key} type="number" min={0} value={edit[l.key] ?? ''} onChange={(e) => setEdit({ ...edit, [l.key]: e.target.value })} placeholder="unlimited" />)}
          </div>
          <div className="mt-3 flex items-center gap-3"><Button onClick={() => save.mutate()} loading={save.isPending} data-testid="save-limits">Save limits</Button><ErrorBox error={save.error} /></div>
        </Card>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const id = useProjectId();
  const [tab, setTab] = useState('general');
  return (
    <div>
      <PageHeader title="Project settings" />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'general', label: 'General' }, { id: 'usage', label: 'Usage & limits' }, { id: 'keys', label: 'API keys' }, { id: 'secrets', label: 'Secrets' }, { id: 'database', label: 'Database' }]} />
      {tab === 'usage' && <Usage id={id} />}
      {tab === 'general' && <General id={id} />}
      {tab === 'keys' && <Keys id={id} />}
      {tab === 'secrets' && <Secrets id={id} />}
      {tab === 'database' && <DatabaseSettings id={id} />}
    </div>
  );
}
