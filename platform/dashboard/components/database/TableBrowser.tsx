'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ErrorBox } from '@/components/ui/Card';
import { formatCell } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

interface Column { name: string; type: string; nullable: boolean; default: string | null; is_primary_key: boolean }

/** Spreadsheet-style row browser with insert / edit / delete by primary key. */
export function TableBrowser({ projectId, table, columns }: { projectId: string; table: string; columns: Column[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [editing, setEditing] = useState<{ row: Record<string, any> | null } | null>(null);
  const limit = 50;
  const key = ['rows', projectId, table, offset, order];
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: key,
    queryFn: () => api.get(`/projects/${projectId}/tables/${table}/rows?limit=${limit}&offset=${offset}${order ? `&order=${order.col}&direction=${order.dir}` : ''}`),
  });
  const pk: string[] = data?.primary_key ?? columns.filter((c) => c.is_primary_key).map((c) => c.name);

  const del = useMutation({
    mutationFn: (row: any) => api.delete(`/projects/${projectId}/tables/${table}/rows`, { match: Object.fromEntries(pk.map((k) => [k, row[k]])) }),
    onSuccess: () => { toast.success('Row deleted'); qc.invalidateQueries({ queryKey: ['rows', projectId, table] }); },
    onError: (e) => toast.error(e),
  });

  const cols: string[] = data?.columns?.length ? data.columns : columns.map((c) => c.name);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setEditing({ row: null })} data-testid="insert-row"><Plus className="h-3.5 w-3.5" />Insert row</Button>
          <Button size="sm" variant="secondary" onClick={() => refetch()}><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />Refresh</Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span data-testid="row-count">{data ? `${data.count === 0 ? 0 : offset + 1}–${Math.min(offset + limit, data.count)} of ${data.count}` : ''}</span>
          <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Previous page"><ChevronLeft className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="secondary" disabled={!data || offset + limit >= data.count} onClick={() => setOffset(offset + limit)} aria-label="Next page"><ChevronRight className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <ErrorBox error={error} />
      {!pk.length && <p className="text-xs text-amber-700">This table has no primary key, so rows cannot be edited here. Use the SQL editor.</p>}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm" data-testid="rows-table">
          <thead className="bg-gray-50">
            <tr>
              {cols.map((c) => (
                <th key={c} className="cursor-pointer whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-gray-600 hover:text-gray-900"
                  onClick={() => setOrder(order?.col === c && order.dir === 'asc' ? { col: c, dir: 'desc' } : { col: c, dir: 'asc' })}>
                  {c}{order?.col === c ? (order.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  <span className="ml-1 font-normal text-gray-400">{columns.find((x) => x.name === c)?.type}</span>
                </th>
              ))}
              <th className="w-16" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && <tr><td className="px-3 py-6 text-center text-gray-500" colSpan={cols.length + 1}>Loading…</td></tr>}
            {data?.data?.length === 0 && <tr><td className="px-3 py-6 text-center text-gray-500" colSpan={cols.length + 1}>No rows</td></tr>}
            {data?.data?.map((row: any, i: number) => (
              <tr key={i} className="hover:bg-gray-50">
                {cols.map((c) => <td key={c} className="max-w-xs truncate whitespace-nowrap px-3 py-1.5 font-mono text-xs">{formatCell(row[c])}</td>)}
                <td className="whitespace-nowrap px-2 text-right">
                  {pk.length > 0 && <>
                    <button aria-label="Edit row" className="p-1 text-gray-400 hover:text-blue-600" onClick={() => setEditing({ row })}><Pencil className="h-3.5 w-3.5" /></button>
                    <button aria-label="Delete row" className="p-1 text-gray-400 hover:text-red-600" onClick={() => { if (confirm('Delete this row?')) del.mutate(row); }}><Trash2 className="h-3.5 w-3.5" /></button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <RowEditor projectId={projectId} table={table} columns={columns} pk={pk} row={editing.row} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RowEditor({ projectId, table, columns, pk, row, onClose }: { projectId: string; table: string; columns: Column[]; pk: string[]; row: Record<string, any> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const editable = columns.filter((c) => !(row === null && c.default?.includes('nextval')) && !/generated always/i.test(c.default ?? ''));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(columns.map((c) => [c.name, row ? (row[c.name] === null ? '' : typeof row[c.name] === 'object' ? JSON.stringify(row[c.name]) : String(row[c.name])) : ''])));
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => Object.fromEntries(columns.map((c) => [c.name, row ? row[c.name] === null : false])));

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, any> = {};
      for (const c of columns) {
        const touched = row ? values[c.name] !== (row[c.name] === null ? '' : typeof row[c.name] === 'object' ? JSON.stringify(row[c.name]) : String(row[c.name])) || nulls[c.name] !== (row[c.name] === null) : values[c.name] !== '' || nulls[c.name];
        if (!touched) continue;
        if (row && pk.includes(c.name)) continue;
        let v: any = nulls[c.name] ? null : values[c.name];
        if (v !== null && /json/.test(c.type)) { try { v = JSON.parse(v); } catch { /* keep string */ } }
        payload[c.name] = v;
      }
      return row
        ? api.patch(`/projects/${projectId}/tables/${table}/rows`, { match: Object.fromEntries(pk.map((k) => [k, row[k]])), values: payload })
        : api.post(`/projects/${projectId}/tables/${table}/rows`, payload);
    },
    onSuccess: () => { toast.success(row ? 'Row updated' : 'Row inserted'); qc.invalidateQueries({ queryKey: ['rows', projectId, table] }); onClose(); },
  });

  return (
    <Modal open onClose={onClose} title={row ? 'Edit row' : `Insert into ${table}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()} data-testid="save-row">Save</Button></>}>
      <div className="space-y-3">
        <ErrorBox error={save.error} />
        {editable.map((c) => (
          <div key={c.name}>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor={`row-${c.name}`} className="text-xs font-medium text-gray-700">{c.name} <span className="font-normal text-gray-400">{c.type}{c.is_primary_key ? ' · primary key' : ''}</span></label>
              {c.nullable && <label className="flex items-center gap-1 text-xs text-gray-500"><input type="checkbox" checked={nulls[c.name]} onChange={(e) => setNulls({ ...nulls, [c.name]: e.target.checked })} />NULL</label>}
            </div>
            {c.type === 'boolean' ? (
              <select id={`row-${c.name}`} className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" disabled={nulls[c.name]} value={values[c.name]} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}>
                <option value="">{row ? '' : `(default${c.default ? ': ' + c.default : ''})`}</option><option value="true">true</option><option value="false">false</option>
              </select>
            ) : (
              <input id={`row-${c.name}`} className="w-full rounded-md border border-gray-300 px-2 py-1.5 font-mono text-sm disabled:bg-gray-100"
                disabled={nulls[c.name] || (!!row && c.is_primary_key)} value={values[c.name]}
                placeholder={!row && c.default ? `default: ${c.default}` : ''} onChange={(e) => setValues({ ...values, [c.name]: e.target.value })} />
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default TableBrowser;
