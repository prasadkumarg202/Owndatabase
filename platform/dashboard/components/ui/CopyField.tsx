'use client';
import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { copyText } from '@/lib/utils';

export function CopyField({ label, value, secret, testId }: { label?: string; value: string; secret?: boolean; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  return (
    <div className="space-y-1">
      {label && <p className="text-xs font-medium text-gray-700">{label}</p>}
      <div className="flex items-center gap-1 rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5">
        <code className="flex-1 truncate font-mono text-xs text-gray-800" data-testid={testId}>{shown ? value : '•'.repeat(Math.min(value.length, 40))}</code>
        {secret && <button aria-label={shown ? 'Hide' : 'Show'} onClick={() => setShown(!shown)} className="rounded p-1 text-gray-500 hover:bg-gray-200">{shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>}
        <button aria-label="Copy" onClick={async () => { if (await copyText(value)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} className="rounded p-1 text-gray-500 hover:bg-gray-200">
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
