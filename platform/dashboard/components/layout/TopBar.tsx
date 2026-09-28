'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { api, currentUser, tokens } from '@/lib/api';
import { StatusBadge } from '@/components/ui/Badge';

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const pid = pathname.match(/^\/projects\/([0-9a-f-]{36})/)?.[1];
  const [menu, setMenu] = useState(false);
  const user = currentUser();

  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: () => api.get('/projects').then((r) => r.data as any[]) });
  const current = projects?.find((p) => p.id === pid);

  async function logout() {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    tokens.clear();
    router.replace('/login');
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="flex items-center gap-3 text-sm">
        {pid ? (
          <>
            <span className="text-gray-400">Project</span>
            <select
              aria-label="Switch project"
              value={pid}
              onChange={(e) => router.push(pathname.replace(pid, e.target.value))}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-900"
            >
              {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {current && <StatusBadge status={current.status} />}
          </>
        ) : <span className="font-medium text-gray-700">Control panel</span>}
      </div>
      <div className="relative">
        <button onClick={() => setMenu(!menu)} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100" data-testid="user-menu">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{user?.email?.[0]?.toUpperCase() ?? '?'}</span>
          <span className="hidden sm:inline">{user?.email}</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {menu && (
          <div className="absolute right-0 z-40 mt-1 w-48 rounded-md border border-gray-200 bg-white py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
            <button onClick={logout} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50">
              <LogOut className="h-4 w-4" />Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
