import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Database } from 'lucide-react';
import { LoginForm } from '@/components/auth/LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500"><Database className="h-5 w-5 text-white" /></div>
          <span className="text-xl font-bold text-white">AapStack</span>
        </div>
        <div className="rounded-lg border border-slate-700 bg-white p-6 shadow-xl">
          <Suspense><LoginForm /></Suspense>
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">Self-hosted PostgreSQL backend platform</p>
      </div>
    </div>
  );
}
