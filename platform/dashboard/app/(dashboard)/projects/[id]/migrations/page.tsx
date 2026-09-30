'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** Schema migrations: the history (also from `odb db push` and branches) and applying a new one (docs/migrations.md). */
export default function MigrationsPage() {
  const id = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['migrations', id], queryFn: () => api.get(`/projects/${id}/migrations`).then((r: any) => r.data as any[]) });
  const [version, setVersion] = useState(stamp());
  const [name, setName] = useState('');
  const [sql, setSql] = useState('-- e.g.\ncreate table if not exists todos (id bigint generated always as identity primary key, title text not null);\n');
  const apply = useMutation({
    mutationFn: (dry: boolean) => api.post(`/projects/${id}/migrations`, { version, name, sql, dry_run: dry }),
    onSuccess: (r: any, dry) => {
      if (dry) { toast.success(`Dry run OK (${r.execution_ms} ms): nothing was changed`); return; }
      toast.success(r.status === 'already_applied' ? 'Already applied' : `Migration ${r.version} applied`);
      qc.invalidateQueries({ queryKey: ['migrations', id] });
      setVersion(stamp()); setName('');
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Migrations" description="Every schema change applied to this project, in order. Migrations run in a transaction as the project owner; a failing one changes nothing." />
      <Card title="New migration">
        <div className="grid gap-3 md:grid-cols-2">
          <Input label="Version" value={version} onChange={(e) => setVersion(e.target.value)} />
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="create_todos" />
        </div>
        <div className="mt-3"><CodeEditor value={sql} onChange={setSql} height="220px" /></div>
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={() => apply.mutate(true)} loading={apply.isPending}>Dry run</Button>
          <Button onClick={() => apply.mutate(false)} loading={apply.isPending} data-testid="apply-migration">Apply migration</Button>
        </div>
      </Card>
      <ErrorBox error={list.error} />
      <DataTable testId="migrations-table" data={list.data} empty="No migrations yet" columns={[
        { key: 'version', label: 'Version', render: (m: any) => <span className="font-mono text-xs">{m.version}</span> },
        { key: 'name', label: 'Name' },
        { key: 'source', label: 'Source', render: (m: any) => <Badge tone="gray">{m.source ?? 'api'}</Badge> },
        { key: 'applied_by', label: 'By', render: (m: any) => m.applied_by ?? '—' },
        { key: 'applied_at', label: 'Applied', render: (m: any) => formatDate(m.applied_at) },
        { key: 'execution_ms', label: 'Time', render: (m: any) => m.execution_ms !== null && m.execution_ms !== undefined ? `${m.execution_ms} ms` : '—' },
      ]} />
    </div>
  );
}
