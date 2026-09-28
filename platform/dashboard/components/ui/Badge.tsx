import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const tones = {
  gray: 'bg-gray-100 text-gray-700 border-gray-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  yellow: 'bg-amber-50 text-amber-800 border-amber-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
};

export function Badge({ children, tone = 'gray', className }: { children: ReactNode; tone?: keyof typeof tones; className?: string }) {
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const s = String(status).toLowerCase();
  const tone = ['active', 'healthy', 'completed', 'verified', 'success', 'ok', 'ready'].includes(s) ? 'green'
    : ['failed', 'error', 'unhealthy', 'unreachable', 'timeout', 'firing'].includes(s) ? 'red'
    : ['paused', 'pending', 'running', 'creating', 'waiting', 'delayed', 'degraded'].includes(s) ? 'yellow' : 'gray';
  return <Badge tone={tone}>{status}</Badge>;
}

export default Badge;
