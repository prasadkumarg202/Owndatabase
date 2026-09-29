'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, timeAgo } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Stat, Tabs } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input, Textarea } from '@/components/ui/Input';
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

function JobQueues({ id }: { id: string }) {
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

function PgQueues({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('{\n  "hello": "world"\n}');
  const list = useQuery({ queryKey: ['pg-queues', id], queryFn: () => api.get(`/projects/${id}/pg-queues`).then((r) => r.data as any[]), refetchInterval: 5000 });
  const msgs = useQuery({ queryKey: ['pg-queue-msgs', id, selected], queryFn: () => api.get(`/projects/${id}/pg-queues/${selected}/messages`).then((r) => r.data as any[]), enabled: !!selected, refetchInterval: 5000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pg-queues', id] }); qc.invalidateQueries({ queryKey: ['pg-queue-msgs', id] }); };
  const create = useMutation({ mutationFn: () => api.post(`/projects/${id}/pg-queues`, { name }), onSuccess: () => { toast.success(`Queue ${name} created`); setSelected(name); setName(''); refresh(); } });
  const send = useMutation({ mutationFn: () => api.post(`/projects/${id}/pg-queues/${selected}/messages`, { message: JSON.parse(message) }), onSuccess: (r) => { toast.success(`Message ${r.msg_id} sent`); refresh(); }, onError: (e) => toast.error(e) });
  const purge = useMutation({ mutationFn: (q: string) => api.post(`/projects/${id}/pg-queues/${q}/purge`), onSuccess: (r) => { toast.success(`${r.deleted} messages deleted`); refresh(); } });
  const drop = useMutation({ mutationFn: (q: string) => api.delete(`/projects/${id}/pg-queues/${q}`), onSuccess: () => { toast.success('Queue dropped'); setSelected(null); refresh(); } });
  return (
    <div className="space-y-6">
      <Card title="Queues in your database" description="Messages are rows in your project schema (q_<name>), transactional with your data. Apps use RPC: queue_send, queue_read, queue_archive, queue_delete, queue_pop — service_role only until you GRANT EXECUTE.">
        <form className="mb-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="w-64"><Input label="New queue" value={name} onChange={(e) => setName(e.target.value)} placeholder="emails" /></div>
          <Button type="submit" loading={create.isPending} disabled={!name} data-testid="create-pg-queue">Create</Button>
          <ErrorBox error={create.error} />
        </form>
        <DataTable testId="pg-queues-table" data={list.data} empty="No queues yet" columns={[
          { key: 'queue_name', label: 'Queue', render: (q: any) => <button className="font-medium text-blue-700 hover:underline" onClick={() => setSelected(q.queue_name)}>{q.queue_name}</button> },
          { key: 'queue_length', label: 'In queue' }, { key: 'visible', label: 'Ready' }, { key: 'archived', label: 'Archived' },
          { key: 'total_messages', label: 'Total sent' },
          { key: 'oldest_msg_age_sec', label: 'Oldest', render: (q: any) => q.oldest_msg_age_sec === null ? '—' : `${q.oldest_msg_age_sec}s` },
          { key: 'x', label: '', render: (q: any) => <div className="flex justify-end gap-2 text-xs">
            <button className="text-gray-600 hover:underline" onClick={() => { if (confirm(`Delete every message in ${q.queue_name}?`)) purge.mutate(q.queue_name); }}>Purge</button>
            <button className="text-red-600 hover:underline" onClick={() => { if (confirm(`Drop queue ${q.queue_name}?`)) drop.mutate(q.queue_name); }}>Drop</button>
          </div> },
        ]} />
      </Card>
      {selected && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title={`Send to ${selected}`}>
            <div className="space-y-3">
              <Textarea label="Message (JSON)" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} />
              <Button onClick={() => { try { JSON.parse(message); send.mutate(); } catch { toast.error('Message is not valid JSON'); } }} loading={send.isPending} data-testid="send-pg-message">Send</Button>
            </div>
          </Card>
          <div className="lg:col-span-2">
            <Card title={`Messages in ${selected}`} description="Peek — reading here does not change visibility" bodyClassName="p-0">
              <DataTable testId="pg-messages-table" data={msgs.data} empty="Empty" columns={[
                { key: 'msg_id', label: 'ID' }, { key: 'read_ct', label: 'Reads' },
                { key: 'enqueued_at', label: 'Enqueued', render: (m: any) => timeAgo(m.enqueued_at) },
                { key: 'vt', label: 'Visible from', render: (m: any) => formatDate(m.vt) },
                { key: 'message', label: 'Message', render: (m: any) => <code className="text-xs">{JSON.stringify(m.message).slice(0, 120)}</code> },
              ]} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

export default function QueuesPage() {
  const id = useProjectId();
  const [tab, setTab] = useState('jobs');
  return (
    <div>
      <PageHeader title="Queues" description="Background jobs (BullMQ on Redis, with retries and a dead-letter queue) and message queues stored in your database." />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'jobs', label: 'Background jobs' }, { id: 'pg', label: 'Postgres queues' }]} />
      {tab === 'jobs' ? <JobQueues id={id} /> : <PgQueues id={id} />}
    </div>
  );
}
