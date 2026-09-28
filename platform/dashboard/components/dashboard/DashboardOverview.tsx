'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, formatDate } from '@/lib/api';
import { Card, PageHeader, Stat } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable } from '@/components/ui/DataTable';
import { CreateProjectModal } from '@/components/projects/CreateProjectModal';

export function DashboardOverview() {
  const [creating, setCreating] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get('/projects').then((r) => r.data as any[]) });
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api.get('/organizations').then((r) => r.data as any[]) });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get('/observability/services').then((r) => r.data as any[]), refetchInterval: 30_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.get('/observability/alerts') });

  const healthy = services.data?.filter((s) => s.status === 'healthy').length ?? 0;

  return (
    <div>
      <PageHeader title="Dashboard" description="Your organizations, projects and platform health"
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New project</Button>} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Projects" value={projects.data?.length ?? '—'} />
        <Stat label="Organizations" value={orgs.data?.length ?? '—'} />
        <Stat label="Services healthy" value={services.data ? `${healthy}/${services.data.length}` : '—'} />
        <Stat label="Active alerts" value={alerts.data?.configured === false ? 'n/a' : (alerts.data?.data?.length ?? '—')}
          hint={alerts.data?.configured === false ? 'Set PROMETHEUS_URL to see alerts' : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Recent projects" actions={<Link href="/projects" className="text-xs text-blue-600 hover:underline">View all</Link>} bodyClassName="p-0">
            <DataTable
              data={projects.data?.slice(0, 8)}
              empty={<span>No projects yet. <button className="text-blue-600 hover:underline" onClick={() => setCreating(true)}>Create one</button></span>}
              columns={[
                { key: 'name', label: 'Name', render: (p) => <Link className="font-medium text-blue-700 hover:underline" href={`/projects/${p.id}`}>{p.name}</Link> },
                { key: 'organization_name', label: 'Organization' },
                { key: 'status', label: 'Status', render: (p) => <StatusBadge status={p.status} /> },
                { key: 'created_at', label: 'Created', render: (p) => formatDate(p.created_at, false) },
              ]}
            />
          </Card>
        </div>
        <Card title="Platform services" description="Live health checks" bodyClassName="p-0">
          <ul className="divide-y divide-gray-100" data-testid="service-list">
            {services.data?.map((s) => (
              <li key={s.name} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-gray-700">{s.name}</span>
                <span className="flex items-center gap-2"><span className="text-xs text-gray-400">{s.latency_ms}ms</span><StatusBadge status={s.status} /></span>
              </li>
            ))}
            {!services.data && <li className="px-4 py-3 text-sm text-gray-500">Checking…</li>}
          </ul>
        </Card>
      </div>
      <CreateProjectModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
