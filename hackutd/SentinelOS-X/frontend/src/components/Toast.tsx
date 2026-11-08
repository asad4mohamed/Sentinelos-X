import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

type ToastKind = 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems(xs => xs.filter(x => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = next.current++;
      setItems(xs => [...xs.slice(-3), { id, kind, text }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
    },
    [dismiss]
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map(t => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm shadow-lg ${
              t.kind === 'error' ? 'border-red-500/40 bg-red-950/90 text-red-100' : 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100'
            }`}
          >
            {t.kind === 'error' ? <XCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <span className="flex-1">{t.text}</span>
            <button className="opacity-70 hover:opacity-100" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
