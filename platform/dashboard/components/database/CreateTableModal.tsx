'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { ErrorBox } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';

const TYPES = ['bigint generated always as identity', 'uuid', 'text', 'varchar(255)', 'integer', 'bigint', 'numeric', 'boolean', 'timestamptz', 'date', 'jsonb', 'text[]', 'double precision'];
const DEFAULTS: Record<string, string> = { uuid: 'gen_random_uuid()', timestamptz: 'now()', boolean: 'false', jsonb: "'{}'::jsonb" };

interface Col { name: string; type: string; nullable: boolean; default: string; primary_key: boolean; unique: boolean; ref: string }
const newCol = (): Col => ({ name: '', type: 'text', nullable: true, default: '', primary_key: false, unique: false, ref: '' });

export function CreateTableModal({ open, onClose, projectId, tables }: { open: boolean; onClose: () => void; projectId: string; tables: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [rls, setRls] = useState(true);
  const [realtime, setRealtime] = useState(false);
  const [cols, setCols] = useState<Col[]>([
    { name: 'id', type: 'bigint generated always as identity', nullable: false, default: '', primary_key: true, unique: false, ref: '' },
    { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', primary_key: false, unique: false, ref: '' },
  ]);
  const set = (i: number, patch: Partial<Col>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const create = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/tables`, {
      name, enable_rls: rls, realtime,
      columns: cols.filter((c) => c.name).map((c) => ({
        name: c.name, type: c.type, nullable: c.nullable, primary_key: c.primary_key, unique: c.unique,
        default: c.default || null,
        references: c.ref ? (c.ref === 'auth.users' ? { schema: 'auth', table: 'users', column: 'id', on_delete: 'CASCADE' } : { table: c.ref, column: 'id', on_delete: 'CASCADE' }) : null,
      })),
    }),
    onSuccess: () => { toast.success(`Table ${name} created`); qc.invalidateQueries({ queryKey: ['tables', projectId] }); setName(''); onClose(); },
  });

  return (
    <Modal open={open} onClose={onClose} title="Create table" wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} disabled={!name} onClick={() => create.mutate()}>Save table</Button></>}>
      <div className="space-y-4">
        <ErrorBox error={create.error} />
        <Input label="Table name" value={name} onChange={(e) => setName(e.target.value)} placeholder="todos" />
        <div className="flex gap-6 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={rls} onChange={(e) => setRls(e.target.checked)} />Enable Row Level Security <span className="text-xs text-gray-500">(recommended)</span></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={realtime} onChange={(e) => setRealtime(e.target.checked)} />Enable realtime</label>
        </div>
        <div className="rounded-md border border-gray-200">
          <div className="grid grid-cols-12 gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500">
            <span className="col-span-3">Name</span><span className="col-span-3">Type</span><span className="col-span-2">Default</span><span className="col-span-2">References</span><span className="col-span-2">Options</span>
          </div>
          {cols.map((c, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2 border-b border-gray-100 px-3 py-2 text-sm" data-testid="column-row">
              <input aria-label="Column name" className="col-span-3 rounded border border-gray-300 px-2 py-1" value={c.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="column_name" />
              <input aria-label="Column type" list="pg-types" className="col-span-3 rounded border border-gray-300 px-2 py-1 font-mono text-xs" value={c.type}
                onChange={(e) => set(i, { type: e.target.value, default: c.default || DEFAULTS[e.target.value] || '' })} />
              <input aria-label="Default" className="col-span-2 rounded border border-gray-300 px-2 py-1 font-mono text-xs" value={c.default} onChange={(e) => set(i, { default: e.target.value })} placeholder="NULL" />
              <select aria-label="References" className="col-span-2 rounded border border-gray-300 px-1 py-1 text-xs" value={c.ref} onChange={(e) => set(i, { ref: e.target.value })}>
                <option value="">—</option><option value="auth.users">auth.users</option>
                {tables.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <div className="col-span-2 flex items-center gap-2 text-xs">
                <label title="Primary key"><input type="checkbox" checked={c.primary_key} onChange={(e) => set(i, { primary_key: e.target.checked })} /> PK</label>
                <label title="Not null"><input type="checkbox" checked={!c.nullable} onChange={(e) => set(i, { nullable: !e.target.checked })} /> NN</label>
                <label title="Unique"><input type="checkbox" checked={c.unique} onChange={(e) => set(i, { unique: e.target.checked })} /> U</label>
                <button aria-label="Remove column" onClick={() => setCols(cols.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
          <datalist id="pg-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
          <div className="px-3 py-2"><Button size="sm" variant="ghost" onClick={() => setCols([...cols, newCol()])}><Plus className="h-3.5 w-3.5" />Add column</Button></div>
        </div>
      </div>
    </Modal>
  );
}

