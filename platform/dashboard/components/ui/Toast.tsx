'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: Kind; message: string }
const Ctx = createContext<(kind: Kind, message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((kind: Kind, message: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, message }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role="status" className="flex items-start gap-2 rounded-md border border-gray-200 bg-white p-3 text-sm shadow-lg">
            {t.kind === 'success' ? <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" /> : t.kind === 'error' ? <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" /> : <Info className="h-4 w-4 text-blue-600 mt-0.5" />}
            <span className="flex-1 break-words text-gray-800">{t.message}</span>
            <button aria-label="Dismiss" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} className="text-gray-400 hover:text-gray-700"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return {
    success: (m: string) => push('success', m),
    error: (m: string | unknown) => push('error', typeof m === 'string' ? m : (m as Error)?.message ?? 'Something went wrong'),
    info: (m: string) => push('info', m),
  };
}

export default ToastProvider;
