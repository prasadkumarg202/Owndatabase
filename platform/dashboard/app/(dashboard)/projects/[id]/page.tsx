'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api, formatBytes } from '@/lib/api';
import { useProject, useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Stat } from '@/components/ui/Card';
import { CopyField } from '@/components/ui/CopyField';
import { StatusBadge } from '@/components/ui/Badge';

export default function ProjectOverviewPage() {
  const id = useProjectId();
  const { data: project, isLoading, error } = useProject(id);
  const usage = useQuery({ queryKey: ['usage', id], queryFn: () => api.get(`/projects/${id}/usage`).then((r) => r.data) });

  if (isLoading) return <p className="text-sm text-gray-500">Loading project…</p>;
  if (error) return <ErrorBox error={error} />;
  const e = project.endpoints;
  const snippet = `const res = await fetch('${e.rest_url}/todos?select=*', {
  headers: { apikey: '<anon key>' }
});`;

  return (
    <div>
      <PageHeader title={<span className="flex items-center gap-3">{project.name} <StatusBadge status={project.status} /></span>}
        description={<>Schema <code className="font-mono">{project.db_schema}</code> · {project.organization_name}</>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Tables" value={project.stats.tables} />
        <Stat label="Auth users" value={project.stats.users} />
        <Stat label="Buckets" value={project.stats.buckets} />
        <Stat label="Functions" value={project.stats.functions} />
        <Stat label="Database size" value={project.stats.db_size} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Connect" description="Use these endpoints with your project API key (header: apikey)">
          <div className="space-y-3">
            <CopyField label="REST API" value={e.rest_url} testId="rest-url" />
            <CopyField label="Auth" value={e.auth_url} />
            <CopyField label="Storage" value={e.storage_url} />
            <CopyField label="Realtime (WebSocket)" value={e.realtime_url} />
            <CopyField label="Functions" value={e.functions_url} />
            <p className="text-xs text-gray-500">API keys are managed in <Link className="text-blue-600 hover:underline" href={`/projects/${id}/settings`}>Settings</Link>. OpenAPI spec: <code>{e.openapi_url}</code></p>
          </div>
        </Card>
        <div className="space-y-6">
          <Card title="Usage">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-gray-500">Storage used</dt><dd className="font-medium">{formatBytes(usage.data?.storage_bytes)} · {usage.data?.storage_objects ?? '—'} files</dd></div>
              <div><dt className="text-gray-500">Active sessions</dt><dd className="font-medium">{usage.data?.active_sessions ?? '—'}</dd></div>
              <div><dt className="text-gray-500">REST requests today</dt><dd className="font-medium">{usage.data?.today?.rest_requests ?? 0}</dd></div>
              <div><dt className="text-gray-500">Function runs (24h)</dt><dd className="font-medium">{usage.data?.function_invocations_24h ?? 0}</dd></div>
            </dl>
          </Card>
          <Card title="Quick start">
            <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
          </Card>
        </div>
      </div>
    </div>
  );
}
