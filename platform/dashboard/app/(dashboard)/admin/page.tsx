'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, formatDate, timeAgo } from '@/lib/api';
import { Card, ErrorBox, PageHeader, Tabs } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';

/** Platform administrators: every user, organization and project (read-only). */
export default function PlatformAdminPage() {
  const [tab, setTab] = useState('projects');
  const [search, setSearch] = useState('');
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api.get('/admin/overview'), retry: false });
  const q = search ? `?search=${encodeURIComponent(search)}` : '';
  const projects = useQuery({ queryKey: ['admin-projects', search], queryFn: () => api.get(`/admin/projects${q}`).then((r: any) => r.data as any[]), enabled: tab === 'projects', retry: false });
  const users = useQuery({ queryKey: ['admin-users', search], queryFn: () => api.get(`/admin/users${q}`).then((r: any) => r.data as any[]), enabled: tab === 'users', retry: false });
  const o = overview.data;
  if (overview.error) return <div><PageHeader title="Platform admin" /><ErrorBox error={overview.error} /></div>;
  return (
    <div className="space-y-4">
      <PageHeader title="Platform admin" description="Every user, organization and project on this platform. Read-only: opening a project's data needs membership of its organization." />
      <div className="grid gap-3 md:grid-cols-5">
        {[['Users', o?.users], ['Organizations', o?.organizations], ['Projects', o?.projects], ['Active projects', o?.active_projects], ['App end users', o?.end_users]].map(([label, n]) => (
          <Card key={String(label)}><p className="text-xs uppercase text-gray-500">{label}</p><p className="mt-1 text-2xl font-semibold">{n ?? '—'}</p></Card>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[{ id: 'projects', label: 'Projects' }, { id: 'users', label: 'Users' }]} />
        <input aria-label="Search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="ml-auto w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm" />
      </div>
      {tab === 'projects' ? (
        <Card bodyClassName="p-0">
          <ErrorBox error={projects.error} />
          <DataTable testId="admin-projects" data={projects.data} empty="No projects" columns={[
            { key: 'name', label: 'Project', render: (p: any) => <span>{p.name}{p.branch_name && <Badge tone="purple" className="ml-2">branch {p.branch_name}</Badge>}</span> },
            { key: 'organization_name', label: 'Organization' },
            { key: 'owner_email', label: 'Owner', render: (p: any) => p.owner_email ?? '—' },
            { key: 'status', label: 'Status', render: (p: any) => <Badge tone={p.status === 'active' ? 'green' : p.status === 'paused' ? 'yellow' : 'gray'}>{p.status}</Badge> },
            { key: 'end_users', label: 'End users' },
            { key: 'created_at', label: 'Created', render: (p: any) => formatDate(p.created_at, false) },
            { key: 'id', label: 'ID', render: (p: any) => <span className="font-mono text-xs text-gray-500">{p.id}</span> },
          ]} />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <ErrorBox error={users.error} />
          <DataTable testId="admin-users" data={users.data} empty="No users" columns={[
            { key: 'email', label: 'Email', render: (u: any) => <span>{u.email}{u.is_platform_admin && <Badge tone="blue" className="ml-2">admin</Badge>}</span> },
            { key: 'name', label: 'Name', render: (u: any) => u.name ?? '—' },
            { key: 'organizations', label: 'Organizations' },
            { key: 'projects', label: 'Projects' },
            { key: 'last_login_at', label: 'Last sign-in', render: (u: any) => u.last_login_at ? timeAgo(u.last_login_at) : 'never' },
            { key: 'created_at', label: 'Joined', render: (u: any) => formatDate(u.created_at, false) },
            { key: 'is_active', label: 'Status', render: (u: any) => <Badge tone={u.is_active ? 'green' : 'gray'}>{u.is_active ? 'active' : 'disabled'}</Badge> },
          ]} />
        </Card>
      )}
    </div>
  );
}
