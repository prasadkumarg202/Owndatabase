'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; className?: string }

export function DataTable<T extends Record<string, any>>({ columns, data, empty = 'No rows', onRowClick, rowKey, testId }: {
  columns: Column<T>[]; data: T[] | undefined; empty?: ReactNode; onRowClick?: (row: T) => void; rowKey?: (row: T, i: number) => string; testId?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white" data-testid={testId}>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={cn('whitespace-nowrap px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500', c.className)}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(!data || data.length === 0) && (
              <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">{empty}</td></tr>
            )}
            {data?.map((row, i) => (
              <tr key={rowKey ? rowKey(row, i) : (row['id'] ?? i)} onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn('hover:bg-gray-50', onRowClick && 'cursor-pointer')}>
                {columns.map((c) => (
                  <td key={c.key} className={cn('whitespace-nowrap px-4 py-2 text-gray-800', c.className)}>
                    {c.render ? c.render(row) : formatCell(row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function formatCell(v: unknown): ReactNode {
  if (v === null || v === undefined) return <span className="text-gray-400">NULL</span>;
  if (typeof v === 'boolean') return <span className={v ? 'text-green-700' : 'text-gray-500'}>{String(v)}</span>;
  if (typeof v === 'object') return <span className="font-mono text-xs">{JSON.stringify(v).slice(0, 120)}</span>;
  const s = String(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

export default DataTable;
