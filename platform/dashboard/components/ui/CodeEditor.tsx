'use client';
import dynamic from 'next/dynamic';
import { sql } from '@codemirror/lang-sql';
import { javascript } from '@codemirror/lang-javascript';

const CodeMirror = dynamic(() => import('@uiw/react-codemirror'), { ssr: false, loading: () => <div className="h-40 animate-pulse bg-gray-50" /> });

export function CodeEditor({ value, onChange, height = '240px', language = 'sql', onRun }: {
  value: string; onChange: (v: string) => void; height?: string; language?: 'sql' | 'javascript'; onRun?: () => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-md border border-gray-300 text-sm"
      data-testid="code-editor"
      onKeyDown={(e) => { if (onRun && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onRun(); } }}
    >
      <CodeMirror value={value} height={height} extensions={[language === 'sql' ? sql() : javascript()]} onChange={onChange} basicSetup={{ lineNumbers: true, foldGutter: false }} />
    </div>
  );
}

export default CodeEditor;
