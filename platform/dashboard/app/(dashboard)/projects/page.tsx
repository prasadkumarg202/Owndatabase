'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, formatDate } from '@/lib/api';
import { PageHeader, Empty } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { CreateProjectModal } from '@/components/projects/CreateProjectModal';

export default function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: () => api.get('/projects').then((r) => r.data as any[]) });
  return (
    <div>
      <PageHeader title="Projects" description="Each project has its own schema, auth users, storage and API keys."
        actions={<Button onClick={() => setOpen(true)} data-testid="new-project"><Plus className="h-4 w-4" />New project</Button>} />
      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {data?.length === 0 && <Empty title="No projects yet">Create your first project to get a database, auth, storage and a REST API.</Empty>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-400 hover:shadow-sm" data-testid="project-card">
            <div className="flex items-start justify-between">
              <h3 className="font-semibold text-gray-900">{p.name}</h3>
              <StatusBadge status={p.status} />
            </div>
            <p className="mt-1 font-mono text-xs text-gray-500">{p.db_schema}</p>
            <p className="mt-3 text-xs text-gray-500">{p.organization_name} · created {formatDate(p.created_at, false)}</p>
          </Link>
        ))}
      </div>
      <CreateProjectModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
