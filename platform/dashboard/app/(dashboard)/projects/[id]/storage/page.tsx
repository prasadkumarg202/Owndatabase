'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, File as FileIcon, Plus, Upload, Trash2, Link2, ChevronRight, Download } from 'lucide-react';
import { formatBytes, formatDate, storage, request } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { Empty, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { CopyField } from '@/components/ui/CopyField';
import { useToast } from '@/components/ui/Toast';

export default function StoragePage() {
  const id = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', public: false, file_size_limit: '', allowed_mime_types: '', write_access: 'owner' });
  const [signed, setSigned] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const buckets = useQuery({ queryKey: ['buckets', id], queryFn: () => storage.get(`/v1/${id}/bucket`) as Promise<any[]> });
  const current = buckets.data?.find((b) => b.name === bucket);
  const objects = useQuery({
    queryKey: ['objects', id, bucket, prefix], enabled: !!bucket,
    queryFn: () => storage.post(`/v1/${id}/object/list/${bucket}`, { prefix, limit: 1000 }) as Promise<any[]>,
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['objects', id, bucket] }); qc.invalidateQueries({ queryKey: ['buckets', id] }); };

  const createBucket = useMutation({
    mutationFn: () => storage.post(`/v1/${id}/bucket`, {
      name: form.name, public: form.public, write_access: form.write_access,
      file_size_limit: form.file_size_limit ? Number(form.file_size_limit) * 1024 * 1024 : null,
      allowed_mime_types: form.allowed_mime_types ? form.allowed_mime_types.split(',').map((s) => s.trim()).filter(Boolean) : null,
    }),
    onSuccess: (b) => { toast.success(`Bucket ${b.name} created`); setCreating(false); setBucket(b.name); setPrefix(''); refresh(); },
  });
  const deleteBucket = useMutation({
    mutationFn: () => storage.delete(`/v1/${id}/bucket/${bucket}?force=true`),
    onSuccess: () => { toast.success('Bucket deleted'); setBucket(null); refresh(); }, onError: (e) => toast.error(e),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await storage.upload(`/v1/${id}/object/${bucket}/${prefix}${f.name}`, f, true);
      return files.length;
    },
    onSuccess: (n) => { toast.success(`Uploaded ${n} file(s)`); refresh(); }, onError: (e) => toast.error(e),
  });
  const remove = useMutation({
    mutationFn: (path: string) => storage.delete(`/v1/${id}/object/${bucket}/${path}`),
    onSuccess: () => { toast.success('Deleted'); refresh(); }, onError: (e) => toast.error(e),
  });
  const sign = useMutation({
    mutationFn: (path: string) => storage.post(`/v1/${id}/object/sign/${bucket}/${path}`, { expiresIn: 3600 }),
    onSuccess: (r) => setSigned(r.signedUrl), onError: (e) => toast.error(e),
  });

  async function download(path: string) {
    const res = await request<Response>(`/storage/v1/${id}/object/${bucket}/${path}`, { rawResponse: true });
    if (!res.ok) return toast.error(`Download failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = path.split('/').pop()!; a.click(); URL.revokeObjectURL(url);
  }

  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <div>
      <PageHeader title="Storage" description="Buckets hold files. Public buckets are readable by anyone; private buckets follow the bucket's access rules."
        actions={<Button onClick={() => setCreating(true)} data-testid="new-bucket"><Plus className="h-4 w-4" />New bucket</Button>} />
      <ErrorBox error={buckets.error} />
      <div className="grid gap-6 lg:grid-cols-4">
        <div className="space-y-1" data-testid="bucket-list">
          {buckets.data?.map((b) => (
            <button key={b.id} onClick={() => { setBucket(b.name); setPrefix(''); }}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${bucket === b.name ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
              <span className="font-medium">{b.name}</span>
              <span className="flex items-center gap-1.5"><span className="text-xs text-gray-400">{b.object_count}</span>{b.public ? <Badge tone="green">public</Badge> : <Badge>private</Badge>}</span>
            </button>
          ))}
          {buckets.data?.length === 0 && <Empty title="No buckets">Create a bucket to store files.</Empty>}
        </div>
        <div className="lg:col-span-3">
          {!current ? <Empty title="Select a bucket" /> : (
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-2">
                <nav className="flex items-center gap-1 text-sm">
                  <button className="font-medium text-blue-700 hover:underline" onClick={() => setPrefix('')}>{current.name}</button>
                  {crumbs.map((c, i) => (
                    <span key={i} className="flex items-center gap-1"><ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                      <button className="hover:underline" onClick={() => setPrefix(crumbs.slice(0, i + 1).join('/') + '/')}>{c}</button></span>
                  ))}
                </nav>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{formatBytes(current.size_bytes)} · write: {current.write_access} · read: {current.read_access}{current.file_size_limit ? ` · max ${formatBytes(current.file_size_limit)}` : ''}</span>
                  <input ref={fileRef} type="file" multiple hidden data-testid="file-input" onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) upload.mutate(files); }} />
                  <Button size="sm" onClick={() => fileRef.current?.click()} loading={upload.isPending}><Upload className="h-3.5 w-3.5" />Upload</Button>
                  <Button size="sm" variant="secondary" onClick={() => { const f = prompt('Folder name'); if (f) setPrefix(`${prefix}${f.replace(/\/+$/, '')}/`); }}>New folder</Button>
                  <Button size="sm" variant="danger" onClick={() => { if (prompt(`Type ${current.name} to delete the bucket and all its files`) === current.name) deleteBucket.mutate(); }}>Delete bucket</Button>
                </div>
              </div>
              <ul className="divide-y divide-gray-100" data-testid="object-list">
                {objects.data?.map((o) => (
                  <li key={o.full_path} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-gray-50">
                    {o.is_folder ? <Folder className="h-4 w-4 text-amber-500" /> : <FileIcon className="h-4 w-4 text-gray-400" />}
                    {o.is_folder
                      ? <button className="flex-1 text-left font-medium hover:underline" onClick={() => setPrefix(o.full_path + '/')}>{o.name}</button>
                      : <span className="flex-1 truncate">{o.name}</span>}
                    {!o.is_folder && <>
                      <span className="w-24 text-right text-xs text-gray-500">{formatBytes(o.metadata?.size)}</span>
                      <span className="hidden w-32 text-xs text-gray-400 md:block">{o.metadata?.mimetype}</span>
                      <span className="hidden w-36 text-xs text-gray-400 md:block">{formatDate(o.updated_at)}</span>
                      <button aria-label="Download" className="p-1 text-gray-400 hover:text-blue-600" onClick={() => download(o.full_path)}><Download className="h-3.5 w-3.5" /></button>
                      <button aria-label="Get link" className="p-1 text-gray-400 hover:text-blue-600" onClick={() => current.public ? setSigned(`${location.origin}/storage/v1/${id}/object/public/${current.name}/${o.full_path}`) : sign.mutate(o.full_path)}><Link2 className="h-3.5 w-3.5" /></button>
                      <button aria-label="Delete file" className="p-1 text-gray-400 hover:text-red-600" onClick={() => { if (confirm(`Delete ${o.name}?`)) remove.mutate(o.full_path); }}><Trash2 className="h-3.5 w-3.5" /></button>
                    </>}
                  </li>
                ))}
                {objects.data?.length === 0 && <li className="px-4 py-8 text-center text-sm text-gray-500">This folder is empty. Upload files or drop them here.</li>}
              </ul>
            </div>
          )}
        </div>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create bucket"
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button onClick={() => createBucket.mutate()} loading={createBucket.isPending} disabled={!form.name} data-testid="create-bucket">Create</Button></>}>
        <div className="space-y-3">
          <ErrorBox error={createBucket.error} />
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} placeholder="avatars" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.public} onChange={(e) => setForm({ ...form, public: e.target.checked })} />Public bucket (files readable without a key)</label>
          <Select label="Who can upload" value={form.write_access} onChange={(e) => setForm({ ...form, write_access: e.target.value })}
            options={[{ value: 'owner', label: 'Signed-in users; they can change only their own files' }, { value: 'authenticated', label: 'Any signed-in user' }, { value: 'service', label: 'Only service_role keys' }]} />
          <Input label="Max file size (MB)" type="number" value={form.file_size_limit} onChange={(e) => setForm({ ...form, file_size_limit: e.target.value })} placeholder="no limit" />
          <Input label="Allowed MIME types" value={form.allowed_mime_types} onChange={(e) => setForm({ ...form, allowed_mime_types: e.target.value })} placeholder="image/*, application/pdf" />
        </div>
      </Modal>
      <Modal open={!!signed} onClose={() => setSigned(null)} title="File link">
        {signed && <CopyField value={signed} label={current?.public ? 'Public URL' : 'Signed URL (valid for 1 hour)'} testId="file-link" />}
      </Modal>
    </div>
  );
}
