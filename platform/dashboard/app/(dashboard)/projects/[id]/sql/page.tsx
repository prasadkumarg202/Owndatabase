'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Search, History } from 'lucide-react';
import { api, timeAgo } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { DataTable } from '@/components/ui/DataTable';

const SNIPPETS: Record<string, string> = {
  'List tables': "select table_name from information_schema.tables where table_schema = current_schema() order by 1;",
  'Create table with RLS': `create table notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
alter table notes enable row level security;
create policy "own notes" on notes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());`,
  'RPC function': `create or replace function add_numbers(a int, b int)
returns int language sql immutable as $$ select a + b $$;`,
};

export default function SqlEditorPage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const [query, setQuery] = useState('select now() as server_time, current_schema() as schema;');
  const history = useQuery({ queryKey: ['history', id], queryFn: () => api.get(`/projects/${id}/query-history`).then((r) => r.data as any[]) });
  const run = useMutation({
    mutationFn: (q: string) => api.post(`/projects/${id}/execute`, { query: q }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['history', id] }); qc.invalidateQueries({ queryKey: ['tables', id] }); },
  });
  const explain = useMutation({ mutationFn: (q: string) => api.post(`/projects/${id}/explain`, { query: q, analyze: true }) });

  const r = run.data;
  return (
    <div>
      <PageHeader title="SQL Editor" description="Runs as the project owner role inside this project's schema. Ctrl/⌘ + Enter to run." />
      <div className="grid gap-6 xl:grid-cols-4">
        <div className="space-y-4 xl:col-span-3">
          <CodeEditor value={query} onChange={setQuery} height="260px" onRun={() => { explain.reset(); run.mutate(query); }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => { explain.reset(); run.mutate(query); }} loading={run.isPending} data-testid="run-sql"><Play className="h-4 w-4" />Run</Button>
            <Button variant="secondary" onClick={() => { run.reset(); explain.mutate(query); }} loading={explain.isPending}><Search className="h-4 w-4" />Explain analyze</Button>
            <select aria-label="Snippets" className="rounded-md border border-gray-300 px-2 py-2 text-sm" value="" onChange={(e) => e.target.value && setQuery(SNIPPETS[e.target.value]!)}>
              <option value="">Insert snippet…</option>
              {Object.keys(SNIPPETS).map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <ErrorBox error={run.error ?? explain.error} />
          {run.error && (run.error as any).body?.hint && <p className="text-xs text-gray-600">Hint: {(run.error as any).body.hint}</p>}
          {r && (
            <div data-testid="sql-result">
              <p className="mb-2 text-xs text-gray-500">{r.command ?? 'OK'} · {r.row_count} row(s) · {r.duration_ms} ms{r.statements > 1 ? ` · ${r.statements} statements (showing last)` : ''}{r.truncated ? ' · truncated' : ''}</p>
              {r.columns?.length > 0 && <DataTable data={r.data} columns={r.columns.map((c: string) => ({ key: c, label: c }))} rowKey={(_, i) => String(i)} />}
            </div>
          )}
          {explain.data && (
            <Card title="Query plan" description={`Planning ${explain.data.planning_time_ms ?? '?'} ms · execution ${explain.data.execution_time_ms ?? '?'} ms (rolled back)`}>
              <pre className="overflow-x-auto text-xs" data-testid="explain-plan">{explain.data.plan}</pre>
            </Card>
          )}
        </div>
        <Card title={<span className="flex items-center gap-1.5"><History className="h-4 w-4" />History</span>} bodyClassName="p-0 max-h-[600px] overflow-y-auto">
          <ul className="divide-y divide-gray-100">
            {history.data?.map((h) => (
              <li key={h.id}>
                <button className="w-full px-3 py-2 text-left hover:bg-gray-50" onClick={() => setQuery(h.query)}>
                  <p className="truncate font-mono text-xs text-gray-800">{h.query}</p>
                  <p className={`mt-0.5 text-[11px] ${h.error ? 'text-red-600' : 'text-gray-400'}`}>{h.error ? 'error · ' : `${h.row_count} rows · ${h.duration_ms} ms · `}{timeAgo(h.executed_at)}</p>
                </button>
              </li>
            ))}
            {history.data?.length === 0 && <li className="px-3 py-4 text-sm text-gray-500">No queries yet</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
