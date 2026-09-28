'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, timeAgo } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Stat } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';
import { StatusBadge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

const EXAMPLES: Record<string, object> = {
  'webhook.dispatch': { url: 'https://example.com/hook', body: { event: 'hello' }, secret: 'optional-signing-secret' },
  'email.send': { to: 'user@example.com', subject: 'Hello', text: 'Sent from a queue job' },
  'function.invoke': { slug: 'hello', body: {} },
  'sql.run': { query: 'delete from logs where created_at < now() - interval \'30 days\'' },
  noop: { hello: 'world' },
  'fail.test': { message: 'testing the dead-letter queue' },
};

export default function QueuesPage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState('noop');
  const [payload, setPayload] = useState(JSON.stringify(EXAMPLES['noop'], null, 2));
  const [attempts, setAttempts] = useState('3');
  const q = useQuery({ queryKey: ['queues', id], queryFn: () => api.get(`/projects/${id}/queues`).then((r) => r.data), refetchInterval: 3000 });
  const dlq = useQuery({ queryKey: ['dlq', id], queryFn: () => api.get(`/projects/${id}/queues/dlq`).then((r) => r.data as any[]), refetchInterval: 5000 });
  const enqueue = useMutation({
    mutationFn: () => api.post(`/projects/${id}/queues/jobs`, { type, payload: JSON.parse(payload), attempts: Number(attempts) }),
    onSuccess: (r) => { toast.success(`Job ${r.id} queued`); qc.invalidateQueries({ queryKey: ['queues', id] }); },
  });
  const retry = useMutation({ mutationFn: (jobId: string) => api.post(`/projects/${id}/queues/jobs/${jobId}/retry`), onSuccess: () => { toast.success('Retrying'); qc.invalidateQueries({ queryKey: ['queues', id] }); }, onError: (e) => toast.error(e) });

  const c = q.data?.counts ?? {};
  return (
    <div>
      <PageHeader title="Queues" description="Background jobs with retries and a dead-letter queue (BullMQ on Redis)." />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {['waiting', 'active', 'delayed', 'completed', 'failed'].map((s) => <Stat key={s} label={s} value={c[s] ?? 0} />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Enqueue a job">
          <div className="space-y-3">
            <Select label="Job type" value={type} onChange={(e) => { setType(e.target.value); setPayload(JSON.stringify(EXAMPLES[e.target.value] ?? {}, null, 2)); }} options={q.data?.job_types ?? Object.keys(EXAMPLES)} />
            <Textarea label="Payload (JSON)" rows={7} value={payload} onChange={(e) => setPayload(e.target.value)} />
            <Select label="Attempts" value={attempts} onChange={(e) => setAttempts(e.target.value)} options={['1', '2', '3', '5', '10']} />
            <ErrorBox error={enqueue.error} />
            <Button onClick={() => { try { JSON.parse(payload); enqueue.mutate(); } catch { toast.error('Payload is not valid JSON'); } }} loading={enqueue.isPending} data-testid="enqueue-job">Enqueue</Button>
          </div>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card title="Recent jobs" bodyClassName="p-0">
            <DataTable testId="jobs-table" data={q.data?.jobs} empty="No jobs yet" columns={[
              { key: 'id', label: 'ID' }, { key: 'name', label: 'Type' },
              { key: 'state', label: 'State', render: (j: any) => <StatusBadge status={j.state} /> },
              { key: 'attempts_made', label: 'Attempts' },
              { key: 'created_at', label: 'Created', render: (j: any) => timeAgo(j.created_at) },
              { key: 'failed_reason', label: 'Result', render: (j: any) => <span className="text-xs">{j.failed_reason ?? (j.return_value ? JSON.stringify(j.return_value).slice(0, 60) : '')}</span> },
              { key: 'x', label: '', render: (j: any) => j.state === 'failed' && <Button size="sm" variant="secondary" onClick={() => retry.mutate(j.id)}>Retry</Button> },
            ]} />
          </Card>
          <Card title={`Dead-letter queue (${dlq.data?.length ?? 0})`} description="Jobs that failed every attempt" bodyClassName="p-0">
            <DataTable data={dlq.data} rowKey={(j: any, i) => `${j.id}-${i}`} empty="Empty" columns={[
              { key: 'id', label: 'Job' }, { key: 'name', label: 'Type' }, { key: 'error', label: 'Error' }, { key: 'attempts', label: 'Attempts' },
              { key: 'failed_at', label: 'Failed', render: (j: any) => timeAgo(j.failed_at) },
            ]} />
          </Card>
        </div>
      </div>
    </div>
  );
}
