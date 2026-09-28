'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, ErrorBox } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';

/** Columns, indexes and constraints with add / drop / rename actions. */
export function TableStructure({ projectId, table, info }: { projectId: string; table: string; info: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [col, setCol] = useState({ name: '', type: 'text', nullable: true, default: '' });
  const [idxCols, setIdxCols] = useState('');
  const [unique, setUnique] = useState(false);

  const alter = useMutation({
    mutationFn: (body: any) => api.patch(`/projects/${projectId}/tables/${table}`, body),
    onSuccess: (r) => { toast.success(r.statement); qc.invalidateQueries({ queryKey: ['table', projectId, table] }); qc.invalidateQueries({ queryKey: ['rows', projectId, table] }); },
    onError: (e) => toast.error(e),
  });

  return (
    <div className="space-y-6">
      <Card title="Columns" bodyClassName="p-0">
        <DataTable data={info.columns} testId="columns-table" columns={[
          { key: 'name', label: 'Name', render: (c: any) => <span className="font-mono">{c.name}{c.is_primary_key && <Badge tone="purple" className="ml-2">PK</Badge>}</span> },
          { key: 'type', label: 'Type', render: (c: any) => <span className="font-mono text-xs">{c.type}</span> },
          { key: 'nullable', label: 'Nullable' },
          { key: 'default', label: 'Default', render: (c: any) => <span className="font-mono text-xs">{c.default ?? ''}</span> },
          { key: 'references', label: 'References', render: (c: any) => c.references ? <span className="font-mono text-xs">{c.references.schema}.{c.references.table}.{c.references.column}</span> : '' },
          { key: 'actions', label: '', render: (c: any) => (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => { const n = prompt(`Rename ${c.name} to:`, c.name); if (n && n !== c.name) alter.mutate({ action: 'rename_column', column_name: c.name, new_name: n }); }}>Rename</Button>
              {!c.is_primary_key && <button aria-label={`Drop column ${c.name}`} className="p-1 text-gray-400 hover:text-red-600" onClick={() => { if (confirm(`Drop column ${c.name}? Data in it is lost.`)) alter.mutate({ action: 'drop_column', column_name: c.name }); }}><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ) },
        ]} />
        <form className="flex flex-wrap items-end gap-2 border-t border-gray-200 p-3" onSubmit={(e) => { e.preventDefault(); alter.mutate({ action: 'add_column', column: { name: col.name, type: col.type, nullable: col.nullable, default: col.default || null } }); setCol({ name: '', type: 'text', nullable: true, default: '' }); }}>
          <div className="w-40"><Input label="New column" placeholder="name" value={col.name} onChange={(e) => setCol({ ...col, name: e.target.value })} /></div>
          <div className="w-40"><Input label="Type" value={col.type} onChange={(e) => setCol({ ...col, type: e.target.value })} list="pg-types-2" /></div>
          <div className="w-40"><Input label="Default" value={col.default} onChange={(e) => setCol({ ...col, default: e.target.value })} placeholder="NULL" /></div>
          <label className="mb-2 flex items-center gap-1 text-xs"><input type="checkbox" checked={!col.nullable} onChange={(e) => setCol({ ...col, nullable: !e.target.checked })} />NOT NULL</label>
          <Button size="sm" type="submit" disabled={!col.name} data-testid="add-column"><Plus className="h-3.5 w-3.5" />Add column</Button>
          <datalist id="pg-types-2">{['text', 'integer', 'bigint', 'boolean', 'uuid', 'timestamptz', 'date', 'jsonb', 'numeric', 'text[]'].map((t) => <option key={t} value={t} />)}</datalist>
        </form>
      </Card>

      <Card title="Indexes" bodyClassName="p-0">
        <DataTable data={info.indexes} columns={[
          { key: 'name', label: 'Name', render: (i: any) => <span className="font-mono text-xs">{i.name}</span> },
          { key: 'definition', label: 'Definition', render: (i: any) => <span className="font-mono text-xs">{i.definition}</span> },
          { key: 'x', label: '', render: (i: any) => !/_pkey$/.test(i.name) && <button aria-label="Drop index" className="p-1 text-gray-400 hover:text-red-600" onClick={() => alter.mutate({ action: 'drop_index', name: i.name })}><Trash2 className="h-3.5 w-3.5" /></button> },
        ]} />
        <form className="flex flex-wrap items-end gap-2 border-t border-gray-200 p-3" onSubmit={(e) => { e.preventDefault(); alter.mutate({ action: 'add_index', columns: idxCols.split(',').map((s) => s.trim()).filter(Boolean), unique }); setIdxCols(''); }}>
          <div className="w-64"><Input label="Index columns" placeholder="col1, col2" value={idxCols} onChange={(e) => setIdxCols(e.target.value)} /></div>
          <label className="mb-2 flex items-center gap-1 text-xs"><input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />Unique</label>
          <Button size="sm" type="submit" disabled={!idxCols}>Create index</Button>
        </form>
      </Card>

      <Card title="Constraints" bodyClassName="p-0">
        <DataTable data={info.constraints} columns={[
          { key: 'name', label: 'Name', render: (c: any) => <span className="font-mono text-xs">{c.name}</span> },
          { key: 'definition', label: 'Definition', render: (c: any) => <span className="font-mono text-xs">{c.definition}</span> },
        ]} />
      </Card>

      <Card title="DDL"><pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{info.ddl}</pre></Card>
      <ErrorBox error={alter.error} />
    </div>
  );
}

export default TableStructure;
