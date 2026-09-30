'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, timeAgo } from '@/lib/api';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { CopyField } from '@/components/ui/CopyField';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

/** Personal access tokens for the odb CLI, the MCP server and scripts calling /api. */
export default function TokensPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tokens'], queryFn: () => api.get('/auth/tokens').then((r: any) => r.data as any[]) });
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post('/auth/tokens', { name, expires_in_days: days === 'never' ? null : Number(days) }),
    onSuccess: (r: any) => { setCreated(r.token); setName(''); qc.invalidateQueries({ queryKey: ['tokens'] }); },
    onError: (e) => toast.error(e),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/tokens/${id}`),
    onSuccess: () => { toast.success('Token revoked'); qc.invalidateQueries({ queryKey: ['tokens'] }); },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="space-y-4">
      <PageHeader title="Access tokens" description="Tokens act as you in the odb CLI (odb login --token), the MCP server and scripts calling the API. Treat them like passwords." />
      <Card title="New token">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64"><Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-deploy" /></div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700" htmlFor="token-exp">Expires</label>
            <select id="token-exp" className="rounded-md border border-gray-300 px-3 py-2 text-sm" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">in 7 days</option><option value="30">in 30 days</option><option value="90">in 90 days</option>
              <option value="365">in a year</option><option value="never">never</option>
            </select>
          </div>
          <Button onClick={() => create.mutate()} disabled={!name.trim()} loading={create.isPending} data-testid="create-token">Create token</Button>
        </div>
        {created && (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="mb-2 text-sm text-amber-900">Copy the token now: it is not shown again.</p>
            <CopyField label="Token" value={created} />
          </div>
        )}
      </Card>
      <ErrorBox error={list.error} />
      <DataTable testId="tokens-table" data={list.data} empty="No tokens" columns={[
        { key: 'name', label: 'Name' },
        { key: 'token_prefix', label: 'Token', render: (t: any) => <span className="font-mono text-xs">{t.token_prefix}…</span> },
        { key: 'status', label: 'Status', render: (t: any) => t.revoked_at ? <Badge tone="gray">revoked</Badge>
          : t.expires_at && new Date(t.expires_at) < new Date() ? <Badge tone="red">expired</Badge> : <Badge tone="green">active</Badge> },
        { key: 'expires_at', label: 'Expires', render: (t: any) => t.expires_at ? formatDate(t.expires_at, false) : 'never' },
        { key: 'last_used_at', label: 'Last used', render: (t: any) => t.last_used_at ? timeAgo(t.last_used_at) : 'never' },
        { key: 'x', label: '', render: (t: any) => !t.revoked_at && <Button size="sm" variant="danger" onClick={() => revoke.mutate(t.id)}>Revoke</Button> },
      ]} />
    </div>
  );
}
