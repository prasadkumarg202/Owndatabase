'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, FolderOpen, Database, Code2, Users, HardDrive, Radio, Zap, Clock, ListOrdered,
  Archive, ScrollText, Activity, Settings, BarChart2, ExternalLink, Home, Building2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const pathname = usePathname();
  const m = pathname.match(/^\/projects\/([0-9a-f-]{36})/);
  const pid = m?.[1];
  const p = (sub: string) => `/projects/${pid}${sub}`;

  const sections: { label?: string; items: { label: string; href: string; icon: any; external?: boolean; exact?: boolean }[] }[] = pid
    ? [
        { items: [{ label: 'All projects', href: '/projects', icon: FolderOpen, exact: true }] },
        { label: 'Project', items: [{ label: 'Overview', href: p(''), icon: Home, exact: true }] },
        { label: 'Database', items: [
          { label: 'Tables', href: p('/database'), icon: Database },
          { label: 'SQL Editor', href: p('/sql'), icon: Code2 },
        ] },
        { label: 'Services', items: [
          { label: 'Authentication', href: p('/auth'), icon: Users },
          { label: 'Storage', href: p('/storage'), icon: HardDrive },
          { label: 'Realtime', href: p('/realtime'), icon: Radio },
          { label: 'Functions', href: p('/functions'), icon: Zap },
          { label: 'Queues', href: p('/queues'), icon: ListOrdered },
          { label: 'Cron Jobs', href: p('/cron'), icon: Clock },
        ] },
        { label: 'Operations', items: [
          { label: 'Backups', href: p('/backups'), icon: Archive },
          { label: 'Logs', href: p('/logs'), icon: ScrollText },
          { label: 'Reports', href: p('/reports'), icon: Activity },
          { label: 'Settings', href: p('/settings'), icon: Settings },
        ] },
      ]
    : [
        { items: [
          { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
          { label: 'Projects', href: '/projects', icon: FolderOpen },
          { label: 'Organizations', href: '/organizations', icon: Building2 },
          { label: 'System status', href: '/status', icon: Activity },
        ] },
      ];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900" data-testid="sidebar">
      <Link href="/dashboard" className="flex h-14 items-center gap-2.5 border-b border-slate-800 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500"><Database className="h-4 w-4 text-white" /></div>
        <span className="text-sm font-bold tracking-tight text-white">OwnDatabase</span>
      </Link>
      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {sections.map((s, i) => (
          <div key={i}>
            {s.label && <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{s.label}</p>}
            <div className="space-y-0.5">
              {s.items.map((it) => {
                const active = it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(it.href + '/') || (it.href.endsWith('/database') && pathname.startsWith(it.href.replace('/database', '/table')));
                const Icon = it.icon;
                return (
                  <Link key={it.label} href={it.href}
                    className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                      active ? 'bg-slate-800 font-medium text-white' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100')}>
                    <Icon className="h-4 w-4 shrink-0" />{it.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-slate-800 p-2">
        <a href="/grafana/" target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-400 hover:bg-slate-800/60 hover:text-slate-100">
          <BarChart2 className="h-4 w-4" />Grafana<ExternalLink className="ml-auto h-3 w-3 opacity-50" />
        </a>
        <a href="/api/docs" target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-slate-400 hover:bg-slate-800/60 hover:text-slate-100">
          <Code2 className="h-4 w-4" />API docs<ExternalLink className="ml-auto h-3 w-3 opacity-50" />
        </a>
      </div>
    </aside>
  );
}
