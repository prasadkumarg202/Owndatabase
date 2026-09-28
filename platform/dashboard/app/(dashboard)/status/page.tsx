'use client';

import { useQuery } from '@tanstack/react-query';
import { api, formatDate } from '@/lib/api';
import { Card, PageHeader } from '@/components/ui/Card';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';

export default function StatusPage() {
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get('/observability/services').then((r) => r.data as any[]), refetchInterval: 15_000 });
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api.get('/observability/alerts'), refetchInterval: 30_000 });
  return (
    <div>
      <PageHeader title="System status" description="Health checks of every platform service and active Prometheus alerts." />
      <div className="space-y-6">
        <Card title="Services" bodyClassName="p-0">
          <DataTable testId="status-services" data={services.data} rowKey={(s: any) => s.name} columns={[
            { key: 'name', label: 'Service' }, { key: 'status', label: 'Status', render: (s: any) => <StatusBadge status={s.status} /> },
            { key: 'latency_ms', label: 'Latency', render: (s: any) => `${s.latency_ms} ms` }, { key: 'url', label: 'Check', render: (s: any) => <span className="font-mono text-xs text-gray-500">{s.url}</span> },
          ]} />
        </Card>
        <Card title="Alerts" description={alerts.data?.configured === false ? 'Prometheus is not configured (PROMETHEUS_URL)' : `${alerts.data?.rule_count ?? 0} alert rules loaded`} bodyClassName="p-0">
          <DataTable data={alerts.data?.data} rowKey={(a: any, i) => `${a.name}-${i}`} empty="No active alerts" columns={[
            { key: 'name', label: 'Alert' }, { key: 'severity', label: 'Severity', render: (a: any) => <Badge tone={a.severity === 'critical' ? 'red' : 'yellow'}>{a.severity}</Badge> },
            { key: 'state', label: 'State', render: (a: any) => <StatusBadge status={a.state} /> }, { key: 'summary', label: 'Summary' },
            { key: 'active_at', label: 'Since', render: (a: any) => formatDate(a.active_at) },
          ]} />
        </Card>
      </div>
    </div>
  );
}
