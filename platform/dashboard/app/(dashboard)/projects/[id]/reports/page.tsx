'use client';

import { useQuery } from '@tanstack/react-query';
import { api, formatBytes, formatDate } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader, Stat } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';

export default function ReportsPage() {
  const id = useProjectId();
  const { data: s, error } = useQuery({ queryKey: ['stats', id], queryFn: () => api.get(`/projects/${id}/stats`).then((r) => r.data), refetchInterval: 15_000 });
  const usage = useQuery({ queryKey: ['usage', id], queryFn: () => api.get(`/projects/${id}/usage`).then((r) => r.data) });
  return (
    <div>
      <PageHeader title="Reports" description="Database health: size, connections, cache, vacuum and slow queries." />
      <ErrorBox error={error} />
      {s && <>
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="report-stats">
          <Stat label="Project schema size" value={formatBytes(s.schema_bytes)} hint={`Whole database: ${formatBytes(s.database_bytes)}`} />
          <Stat label="Connections" value={`${s.connections} / ${s.max_connections}`} hint={s.connections_by_state.map((c: any) => `${c.state}: ${c.count}`).join(' · ')} />
          <Stat label="Cache hit ratio" value={`${(s.cache_hit_ratio * 100).toFixed(1)}%`} hint="Aim for > 99%" />
          <Stat label="Transactions" value={s.transactions.commits?.toLocaleString()} hint={`${s.transactions.rollbacks} rollbacks · ${s.transactions.deadlocks} deadlocks`} />
        </div>
        <div className="space-y-6">
          <Card title="Tables & vacuum" bodyClassName="p-0">
            <DataTable data={s.tables} rowKey={(t: any) => t.table} empty="No tables" columns={[
              { key: 'table', label: 'Table' }, { key: 'live_rows', label: 'Live rows' },
              { key: 'dead_rows', label: 'Dead rows', render: (t: any) => t.live_rows && t.dead_rows / Math.max(t.live_rows, 1) > 0.2 ? <Badge tone="yellow">{t.dead_rows}</Badge> : t.dead_rows },
              { key: 'total_bytes', label: 'Size', render: (t: any) => formatBytes(t.total_bytes) },
              { key: 'seq_scan', label: 'Seq scans' }, { key: 'idx_scan', label: 'Index scans' },
              { key: 'last_autovacuum', label: 'Last (auto)vacuum', render: (t: any) => formatDate(t.last_autovacuum ?? t.last_vacuum) },
              { key: 'last_autoanalyze', label: 'Last analyze', render: (t: any) => formatDate(t.last_autoanalyze ?? t.last_analyze) },
            ]} />
          </Card>
          <Card title="Slowest queries" description="From pg_stat_statements (mean execution time)" bodyClassName="p-0">
            <DataTable data={s.slow_queries} rowKey={(_: any, i) => String(i)} empty="No statistics yet" columns={[
              { key: 'mean_ms', label: 'Mean ms' }, { key: 'calls', label: 'Calls' }, { key: 'total_ms', label: 'Total ms' },
              { key: 'query', label: 'Query', render: (q: any) => <span className="block max-w-2xl truncate font-mono text-xs" title={q.query}>{q.query}</span> },
            ]} />
          </Card>
          {usage.data && (
            <Card title="Usage today">
              <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                {Object.entries(usage.data.today ?? {}).map(([k, v]) => <div key={k}><dt className="text-xs text-gray-500">{k.replace(/_/g, ' ')}</dt><dd className="font-medium">{String(v)}</dd></div>)}
                {Object.keys(usage.data.today ?? {}).length === 0 && <p className="text-gray-500">No API activity yet today</p>}
              </dl>
            </Card>
          )}
        </div>
      </>}
    </div>
  );
}
