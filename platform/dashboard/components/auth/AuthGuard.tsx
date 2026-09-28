'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { tokens } from '@/lib/api';

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!tokens.access) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else setOk(true);
  }, [pathname, router]);
  if (!ok) return <div className="flex h-screen items-center justify-center text-sm text-gray-500">Loading…</div>;
  return <>{children}</>;
}
