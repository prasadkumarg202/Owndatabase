'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ErrorBox } from '@/components/ui/Card';
import { CopyField } from '@/components/ui/CopyField';

export function CreateProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [org, setOrg] = useState('');
  const [created, setCreated] = useState<any>(null);
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api.get('/organizations').then((r) => r.data as any[]), enabled: open });

  const autoSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 30);
  const create = useMutation({
    mutationFn: () => api.post('/projects', { name, slug: slug || autoSlug || undefined, organization_id: org || orgs.data?.[0]?.id }),
    onSuccess: (p) => { setCreated(p); qc.invalidateQueries({ queryKey: ['projects'] }); },
  });

  function close() {
    setName(''); setSlug(''); setCreated(null); create.reset(); onClose();
  }

  if (created) {
    return (
      <Modal open={open} onClose={close} title="Project created"
        footer={<Button onClick={() => { const id = created.id; close(); router.push(`/projects/${id}`); }}>Open project</Button>}>
        <div className="space-y-3" data-testid="project-created">
          <p className="text-sm text-gray-700"><strong>{created.name}</strong> is ready. Copy the API keys now — they are shown only once.</p>
          <CopyField label="anon key (safe for browsers)" value={created.api_keys.anon} testId="anon-key" />
          <CopyField label="service_role key (server only, bypasses RLS)" value={created.api_keys.service_role} secret testId="service-key" />
          <CopyField label="REST URL" value={created.endpoints.rest_url} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title="Create a new project"
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>Create project</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <ErrorBox error={create.error} />
        <Input label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" autoFocus />
        <Input label="Slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder={autoSlug || 'my-app'}
          hint="Lowercase letters, numbers and dashes. Used for the database schema name." />
        {(orgs.data?.length ?? 0) > 1 && (
          <Select label="Organization" value={org} onChange={(e) => setOrg(e.target.value)} options={orgs.data!.map((o) => ({ value: o.id, label: o.name }))} />
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
