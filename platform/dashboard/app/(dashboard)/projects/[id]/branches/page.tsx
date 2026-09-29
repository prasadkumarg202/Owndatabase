'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { api, formatDate } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { CopyField } from '@/components/ui/CopyField';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';

export default function BranchesPage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [withData, setWithData] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const list = useQuery({ queryKey: ['branches', id], queryFn: () => api.get(`/projects/${id}/branches`).then((r) => r.data as any[]) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['branches', id] }); qc.invalidateQueries({ queryKey: ['projects'] }); };
  const create = useMutation({ mutationFn: () => api.post(`/projects/${id}/branches`, { name, with_data: withData }), onSuccess: (r) => { setCreated(r); setName(''); refresh(); } });
  const merge = useMutation({
    mutationFn: (b: any) => api.post(`/projects/${id}/branches/${b.id}/merge`, {}),
    onSuccess: (r) => { toast.success(r.applied.length ? `Merged ${r.applied.length} migration(s)` : 'Nothing to merge'); refresh(); },
    onError: (e) => toast.error(e),
  });
  const del = useMutation({ mutationFn: (b: any) => api.delete(`/projects/${id}/branches/${b.id}`), onSuccess: () => { toast.success('Branch deleted'); refresh(); } });

  return (
    <div>
      <PageHeader title="Branches" description="Separate copies of this project's database for previews and development: own keys, users and storage. Push migrations to a branch, then merge them here." />
      <Card title="New branch">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="w-64"><Input label="Branch name" value={name} onChange={(e) => setName(e.target.value)} placeholder="feature-login" /></div>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />Copy data too</label>
          <Button type="submit" loading={create.isPending} disabled={!name} data-testid="create-branch"><GitBranch className="h-4 w-4" />Create branch</Button>
        </form>
        <ErrorBox error={create.error} />
      </Card>
      <Card className="mt-6" title="Branches" bodyClassName="p-0">
        <DataTable testId="branches-table" data={list.data} empty="No branches" columns={[
          { key: 'branch_name', label: 'Branch', render: (b: any) => <Link className="font-medium text-blue-700 hover:underline" href={`/projects/${b.id}`}>{b.branch_name}</Link> },
          { key: 'status', label: 'Status', render: (b: any) => <StatusBadge status={b.status} /> },
          { key: 'unmerged_migrations', label: 'Unmerged migrations', render: (b: any) => b.unmerged_migrations ? <Badge tone="yellow">{b.unmerged_migrations}</Badge> : 0 },
          { key: 'created_at', label: 'Created', render: (b: any) => formatDate(b.created_at) },
          { key: 'x', label: '', render: (b: any) => <div className="flex justify-end gap-1">
            <Button size="sm" variant="secondary" disabled={!b.unmerged_migrations} onClick={() => { if (confirm(`Apply ${b.unmerged_migrations} migration(s) from ${b.branch_name} to this project?`)) merge.mutate(b); }}>Merge</Button>
            <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete branch ${b.branch_name} and its data?`)) del.mutate(b); }}>Delete</Button>
          </div> },
        ]} />
      </Card>
      <Modal open={!!created} onClose={() => setCreated(null)} title={`Branch ${created?.branch_name ?? ''} created`}>
        {created && <div className="space-y-2">
          <p className="text-sm text-amber-700">Its keys are shown once — store them now.</p>
          <CopyField label="REST URL" value={created.endpoints.rest_url} />
          <CopyField label="anon key" value={created.api_keys.anon} testId="branch-anon-key" />
          <CopyField label="service_role key" value={created.api_keys.service_role} secret />
        </div>}
      </Modal>
    </div>
  );
}
