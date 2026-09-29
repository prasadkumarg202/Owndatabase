'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '@/lib/api';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api.get(`/invitations/${token}`), retry: false });
  const accept = useMutation({
    mutationFn: () => api.post(`/invitations/${token}/accept`),
    onSuccess: () => { toast.success(`You joined ${invite.data?.organization_name}`); qc.invalidateQueries(); router.replace('/organizations'); },
  });
  const decline = useMutation({
    mutationFn: () => api.post(`/invitations/${token}/decline`),
    onSuccess: () => { toast.success('Invitation declined'); router.replace('/dashboard'); },
  });

  const i = invite.data;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Organization invitation" />
      <ErrorBox error={invite.error} />
      {i && (
        <Card>
          <div className="space-y-3 text-sm" data-testid="invite-details">
            <p><strong>{i.invited_by_email ?? 'Someone'}</strong> invited <strong>{i.email}</strong> to join <strong>{i.organization_name}</strong> as <strong>{i.role}</strong>.</p>
            {i.status !== 'pending' && <p className="text-red-600">This invitation has {i.status === 'expired' ? 'expired' : `been ${i.status}`}.</p>}
            {i.status === 'pending' && !i.email_matches && (
              <p className="text-amber-700">You are signed in with a different email. Sign out and sign in (or sign up) as {i.email} to accept.</p>
            )}
            {i.status === 'pending' && <p className="text-xs text-gray-500">Expires {formatDate(i.expires_at)}</p>}
            <ErrorBox error={accept.error ?? decline.error} />
            {i.status === 'pending' && i.email_matches && (
              <div className="flex gap-2">
                <Button onClick={() => accept.mutate()} loading={accept.isPending} data-testid="accept-invite">Accept and join</Button>
                <Button variant="secondary" onClick={() => decline.mutate()} loading={decline.isPending}>Decline</Button>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
