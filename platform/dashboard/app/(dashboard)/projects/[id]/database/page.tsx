'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { CreateTableModal } from '@/components/database/CreateTableModal';

export default function DatabasePage() {
  const id = useProjectId();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['tables', id], queryFn: () => api.get(`/projects/${id}/tables`).then((r) => r.data as any[]) });
  return (
    <div>
      <PageHeader title="Tables" description="Tables in this project's schema. Every table gets a REST endpoint automatically."
        actions={<Button onClick={() => setOpen(true)} data-testid="new-table"><Plus className="h-4 w-4" />New table</Button>} />
      <ErrorBox error={error} />
      {isLoading ? <p className="text-sm text-gray-500">Loading…</p> : (
        <DataTable testId="tables-list" data={data} empty="No tables yet — create one or use the SQL editor."
          columns={[
            { key: 'name', label: 'Name', render: (t) => <Link className="font-medium text-blue-700 hover:underline" href={`/projects/${id}/table?name=${encodeURIComponent(t.name)}`}>{t.name}</Link> },
            { key: 'row_count', label: 'Rows (est.)' },
            { key: 'size', label: 'Size' },
            { key: 'rls_enabled', label: 'RLS', render: (t) => t.rls_enabled ? <Badge tone="green">on · {t.policy_count} policies</Badge> : <Badge tone="yellow">off</Badge> },
            { key: 'realtime_enabled', label: 'Realtime', render: (t) => t.realtime_enabled ? <Badge tone="blue">on</Badge> : <Badge>off</Badge> },
            { key: 'comment', label: 'Description' },
          ]} />
      )}
      <CreateTableModal open={open} onClose={() => setOpen(false)} projectId={id} tables={data?.map((t) => t.name) ?? []} />
    </div>
  );
}
