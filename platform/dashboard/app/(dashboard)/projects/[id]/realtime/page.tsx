'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, tokens } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';

interface Msg { at: string; data: any }

export default function RealtimePage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const tables = useQuery({ queryKey: ['tables', id], queryFn: () => api.get(`/projects/${id}/tables`).then((r) => r.data as any[]) });
  const toggle = useMutation({
    mutationFn: (t: any) => api.post(`/projects/${id}/tables/${t.name}/realtime`, { enabled: !t.realtime_enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables', id] }), onError: (e) => toast.error(e),
  });

  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [channel, setChannel] = useState('db:*');
  const [bchannel, setBchannel] = useState('room1');
  const [bpayload, setBpayload] = useState('{"hello":"world"}');

  function connect() {
    const base = process.env['NEXT_PUBLIC_REALTIME_URL'] || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/realtime`;
    const ws = new WebSocket(`${base}?project_id=${id}&token=${encodeURIComponent(tokens.access ?? '')}`);
    wsRef.current = ws;
    setStatus('connecting');
    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => toast.error('Realtime connection failed');
    ws.onmessage = (e) => setMessages((m) => [{ at: new Date().toLocaleTimeString(), data: JSON.parse(e.data) }, ...m].slice(0, 200));
  }
  const send = (obj: any) => wsRef.current?.readyState === 1 ? wsRef.current.send(JSON.stringify(obj)) : toast.error('Not connected');
  useEffect(() => () => wsRef.current?.close(), []);

  return (
    <div>
      <PageHeader title="Realtime" description="Stream database changes, broadcast messages and presence over WebSockets." />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Tables" description="Enable change events per table" className="lg:col-span-2" bodyClassName="p-0">
          <ul className="divide-y divide-gray-100" data-testid="realtime-tables">
            {tables.data?.map((t) => (
              <li key={t.name} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="font-mono">{t.name}</span>
                <label className="flex items-center gap-2 text-xs">
                  {t.realtime_enabled ? <Badge tone="blue">on</Badge> : <Badge>off</Badge>}
                  <input type="checkbox" aria-label={`Realtime for ${t.name}`} checked={t.realtime_enabled} onChange={() => toggle.mutate(t)} />
                </label>
              </li>
            ))}
            {tables.data?.length === 0 && <li className="px-4 py-4 text-sm text-gray-500">No tables yet</li>}
          </ul>
        </Card>
        <Card title="Inspector" className="lg:col-span-3"
          actions={<>
            <Badge tone={status === 'connected' ? 'green' : status === 'connecting' ? 'yellow' : 'gray'}>{status}</Badge>
            {status === 'disconnected' ? <Button size="sm" onClick={connect} data-testid="rt-connect">Connect</Button> : <Button size="sm" variant="secondary" onClick={() => wsRef.current?.close()}>Disconnect</Button>}
          </>}>
          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <div className="flex items-end gap-2">
              <Input label="Subscribe to" value={channel} onChange={(e) => setChannel(e.target.value)} hint="db:<table>, db:*, broadcast:<name>, presence:<room>" />
              <Button size="sm" className="mb-5" onClick={() => send({ type: 'subscribe', channel })} data-testid="rt-subscribe">Subscribe</Button>
            </div>
            <div className="flex items-end gap-2">
              <Input label="Broadcast to" value={bchannel} onChange={(e) => setBchannel(e.target.value)} />
              <Input label="Payload" value={bpayload} onChange={(e) => setBpayload(e.target.value)} />
              <Button size="sm" variant="secondary" className="mb-5" onClick={() => { try { send({ type: 'broadcast', channel: bchannel, event: 'message', payload: JSON.parse(bpayload), self: true }); } catch { toast.error('Payload must be JSON'); } }}>Send</Button>
            </div>
          </div>
          <div className="h-96 overflow-y-auto rounded-md border border-gray-200 bg-slate-950 p-2 font-mono text-xs text-slate-200" data-testid="rt-messages">
            {messages.length === 0 && <p className="text-slate-500">Connect and subscribe to see messages…</p>}
            {messages.map((m, i) => <div key={i} className="border-b border-slate-800 py-1"><span className="text-slate-500">{m.at}</span> {JSON.stringify(m.data)}</div>)}
          </div>
        </Card>
      </div>
    </div>
  );
}
