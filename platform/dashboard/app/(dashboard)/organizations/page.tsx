'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api, formatDate } from '@/lib/api';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { CopyField } from '@/components/ui/CopyField';
import { useToast } from '@/components/ui/Toast';

const ROLES = ['owner', 'admin', 'developer', 'viewer', 'billing', 'support'];

function Members({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => api.get(`/organizations/${orgId}`) });
  const manager = ['owner', 'admin'].includes(org.data?.member_role);
  const invites = useQuery({ queryKey: ['invites', orgId], queryFn: () => api.get(`/organizations/${orgId}/invitations`).then((r) => r.data as any[]), enabled: manager });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [link, setLink] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () => api.post(`/organizations/${orgId}/invitations`, { email, role }),
    onSuccess: (r) => { setLink(r.invite_url); setEmail(''); toast.success(`Invitation sent to ${r.email}`); qc.invalidateQueries({ queryKey: ['invites', orgId] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/organizations/${orgId}/invitations/${id}`),
    onSuccess: () => { toast.success('Invitation revoked'); qc.invalidateQueries({ queryKey: ['invites', orgId] }); },
    onError: (e) => toast.error(e),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => api.patch(`/organizations/${orgId}/members/${userId}`, { role }),
    onSuccess: () => { toast.success('Role updated'); qc.invalidateQueries({ queryKey: ['org', orgId] }); },
    onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/organizations/${orgId}/members/${userId}`),
    onSuccess: () => { toast.success('Member removed'); qc.invalidateQueries({ queryKey: ['org', orgId] }); },
    onError: (e) => toast.error(e),
  });

  const isOwner = org.data?.member_role === 'owner';
  return (
    <div className="space-y-6">
      <Card title="Members" bodyClassName="p-0">
        <DataTable testId="members-table" data={org.data?.members}
          columns={[
            { key: 'email', label: 'Email', render: (m: any) => <span>{m.email}{m.name ? <span className="ml-2 text-gray-400">{m.name}</span> : null}</span> },
            { key: 'role', label: 'Role', render: (m: any) => isOwner
              ? <select aria-label={`Role of ${m.email}`} className="rounded border border-gray-300 px-2 py-1 text-xs" value={m.role} onChange={(e) => changeRole.mutate({ userId: m.id, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
              : <Badge>{m.role}</Badge> },
            { key: 'joined_at', label: 'Joined', render: (m: any) => m.joined_at ? formatDate(m.joined_at, false) : '—' },
            { key: 'actions', label: '', render: (m: any) => manager && <button className="text-xs text-red-600 hover:underline" onClick={() => { if (confirm(`Remove ${m.email}?`)) remove.mutate(m.id); }}>Remove</button> },
          ]} />
      </Card>

      {manager && (
        <Card title="Invite people" description="They get an email with a link valid for 7 days. They can sign up with that address if they have no account yet.">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <div className="min-w-64 flex-1"><Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" /></div>
            <div className="w-40"><Select label="Role" value={role} onChange={(e) => setRole(e.target.value)} options={isOwner ? ROLES : ROLES.filter((r) => r !== 'owner')} /></div>
            <Button type="submit" loading={invite.isPending} data-testid="send-invite"><UserPlus className="h-4 w-4" />Invite</Button>
          </form>
          <ErrorBox error={invite.error} />
          {link && <div className="mt-3"><CopyField label="Invitation link (also emailed)" value={link} testId="invite-link" /></div>}
        </Card>
      )}

      {manager && (
        <Card title="Pending invitations" bodyClassName="p-0">
          <DataTable testId="invites-table" data={invites.data} empty="No pending invitations"
            columns={[
              { key: 'email', label: 'Email' },
              { key: 'role', label: 'Role', render: (i: any) => <Badge>{i.role}</Badge> },
              { key: 'invited_by_email', label: 'Invited by' },
              { key: 'expires_at', label: 'Expires', render: (i: any) => formatDate(i.expires_at, false) },
              { key: 'actions', label: '', render: (i: any) => <button className="text-xs text-red-600 hover:underline" onClick={() => revoke.mutate(i.id)}>Revoke</button> },
            ]} />
        </Card>
      )}
    </div>
  );
}

export default function OrganizationsPage() {
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api.get('/organizations').then((r) => r.data as any[]) });
  const [orgId, setOrgId] = useState<string | null>(null);
  useEffect(() => { if (!orgId && orgs.data?.length) setOrgId(orgs.data[0].id); }, [orgs.data, orgId]);
  return (
    <div>
      <PageHeader title="Organizations" description="Members, roles and invitations"
        actions={orgs.data && orgs.data.length > 1
          ? <div className="w-64"><Select aria-label="Organization" value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)} options={orgs.data.map((o) => ({ value: o.id, label: `${o.name} (${o.member_role})` }))} /></div>
          : undefined} />
      {orgId ? <Members key={orgId} orgId={orgId} /> : <p className="text-sm text-gray-500">Loading…</p>}
    </div>
  );
}
