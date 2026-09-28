'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Trash2 } from 'lucide-react';
import { api, formatDate, timeAgo } from '@/lib/api';
import { useProject, useProjectId } from '@/lib/hooks';
import { Card, Empty, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { CopyField } from '@/components/ui/CopyField';
import { useToast } from '@/components/ui/Toast';

const TEMPLATE = `// Runs in an isolated Node.js process. Secrets are in req.env.
export default async function (req) {
  const { name = 'world' } = req.query;
  console.log('invoked by', req.headers['x-odb-role']);
  return { status: 200, body: { message: \`Hello \${name}!\` } };
}
`;

export default function FunctionsPage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: project } = useProject(id);
  const list = useQuery({ queryKey: ['functions', id], queryFn: () => api.get(`/projects/${id}/functions`).then((r) => r.data as any[]) });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ slug: string; code: string; verify_jwt: boolean; timeout_ms: number } | null>(null);

  const fn = useQuery({ queryKey: ['function', id, selected], enabled: !!selected, queryFn: () => api.get(`/projects/${id}/functions/${selected}`) });
  const logs = useQuery({ queryKey: ['function-logs', id, selected], enabled: !!selected, queryFn: () => api.get(`/projects/${id}/functions/${selected}/logs`).then((r) => r.data as any[]), refetchInterval: 5000 });

  const deploy = useMutation({
    mutationFn: (d: NonNullable<typeof draft>) => api.post(`/projects/${id}/functions`, d),
    onSuccess: (r) => { toast.success(`Deployed ${r.slug} v${r.version}`); qc.invalidateQueries({ queryKey: ['functions', id] }); qc.invalidateQueries({ queryKey: ['function', id, r.slug] }); setSelected(r.slug); setDraft(null); },
  });
  const invoke = useMutation({
    mutationFn: () => api.post(`/projects/${id}/functions/${selected}/invoke-async`, {}),
    onSuccess: (r) => toast.success(`Queued background run (job ${r.job_id}) — see logs below`), onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/projects/${id}/functions/${selected}`),
    onSuccess: () => { toast.success('Function deleted'); setSelected(null); qc.invalidateQueries({ queryKey: ['functions', id] }); },
  });

  const editing = draft ?? (fn.data ? { slug: fn.data.slug, code: fn.data.code, verify_jwt: fn.data.verify_jwt, timeout_ms: fn.data.timeout_ms } : null);

  return (
    <div>
      <PageHeader title="Functions" description="Server-side JavaScript endpoints. Call them at <functions url>/<slug> with your API key."
        actions={<Button onClick={() => { setSelected(null); setDraft({ slug: '', code: TEMPLATE, verify_jwt: false, timeout_ms: 5000 }); }} data-testid="new-function"><Plus className="h-4 w-4" />New function</Button>} />
      <div className="grid gap-6 lg:grid-cols-4">
        <div className="space-y-1" data-testid="function-list">
          {list.data?.map((f) => (
            <button key={f.id} onClick={() => { setDraft(null); setSelected(f.slug); }}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm ${selected === f.slug && !draft ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
              <div className="flex items-center justify-between"><span className="font-medium">{f.slug}</span><span className="text-xs text-gray-400">v{f.version}</span></div>
              <p className="mt-0.5 text-xs text-gray-500">{f.invocations_24h} runs · {f.errors_24h} errors (24h)</p>
            </button>
          ))}
          {list.data?.length === 0 && !draft && <Empty title="No functions yet" />}
        </div>
        <div className="space-y-4 lg:col-span-3">
          {editing && (
            <Card title={draft ? 'New function' : `${editing.slug}`} description={fn.data && !draft ? `Version ${fn.data.version} · updated ${formatDate(fn.data.updated_at)}` : undefined}
              actions={!draft && selected ? <>
                <Button size="sm" variant="secondary" onClick={() => invoke.mutate()} loading={invoke.isPending}><Play className="h-3.5 w-3.5" />Run in background</Button>
                <Button size="sm" variant="danger" onClick={() => { if (confirm(`Delete ${selected}?`)) remove.mutate(); }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </> : undefined}>
              <div className="space-y-3">
                <ErrorBox error={deploy.error} />
                <div className="grid gap-3 md:grid-cols-3">
                  <Input label="Slug" value={editing.slug} disabled={!draft} onChange={(e) => setDraft({ ...editing, slug: e.target.value.toLowerCase() })} placeholder="hello-world" />
                  <Input label="Timeout (ms)" type="number" value={editing.timeout_ms} onChange={(e) => setDraft({ ...editing, timeout_ms: Number(e.target.value) })} />
                  <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.verify_jwt} onChange={(e) => setDraft({ ...editing, verify_jwt: e.target.checked })} />Require signed-in user</label>
                </div>
                <CodeEditor language="javascript" value={editing.code} onChange={(code) => setDraft({ ...editing, code })} height="320px" />
                <div className="flex items-center gap-3">
                  <Button onClick={() => deploy.mutate(editing)} loading={deploy.isPending} disabled={!editing.slug} data-testid="deploy-function">Deploy</Button>
                  {project && editing.slug && <div className="flex-1"><CopyField value={`${project.endpoints.functions_url}/${editing.slug}`} /></div>}
                </div>
              </div>
            </Card>
          )}
          {selected && !draft && (
            <Card title="Invocations" description="Refreshes every 5 seconds" bodyClassName="p-0">
              <ul className="max-h-96 divide-y divide-gray-100 overflow-y-auto" data-testid="function-logs">
                {logs.data?.map((l) => (
                  <li key={l.id} className="px-4 py-2 text-xs">
                    <div className="flex items-center gap-2"><StatusBadge status={l.status} /><span>HTTP {l.status_code}</span><span className="text-gray-400">{l.duration_ms} ms · v{l.version} · {timeAgo(l.created_at)}</span></div>
                    {l.logs && <pre className="mt-1 whitespace-pre-wrap text-gray-600">{l.logs}</pre>}
                    {l.error && <pre className="mt-1 whitespace-pre-wrap text-red-600">{l.error}</pre>}
                  </li>
                ))}
                {logs.data?.length === 0 && <li className="px-4 py-4 text-sm text-gray-500">No invocations yet</li>}
              </ul>
            </Card>
          )}
          {!editing && !selected && <Empty title="Select or create a function"><Badge>Node.js 20 · ES modules</Badge></Empty>}
        </div>
      </div>
    </div>
  );
}
