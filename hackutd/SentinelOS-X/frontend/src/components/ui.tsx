import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { AlertCircle, Inbox, X } from 'lucide-react';

export function Panel({ title, actions, children, className = '', bodyClass = 'p-4' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`panel flex min-h-0 flex-col ${className}`}>
      {(title || actions) && (
        <header className="panel-header">
          <h2 className="panel-title">{title}</h2>
          {actions}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function MetricCard({ label, value, icon: Icon, tone = 'text-cyan-300', hint }: { label: string; value: ReactNode; icon: ComponentType<{ className?: string }>; tone?: string; hint?: string }) {
  return (
    <div className="panel flex items-center gap-4 px-4 py-3.5">
      <div className={`rounded-md bg-ink-800 p-2.5 ${tone}`}>
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold tracking-[0.12em] text-slate-400 uppercase">{label}</div>
        <div className="text-2xl font-semibold text-slate-50 tabular-nums">{value}</div>
        {hint && <div className="truncate text-xs text-slate-500">{hint}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, icon: Icon = Inbox, action }: { title: string; hint?: string; icon?: ComponentType<{ className?: string }>; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon className="size-8 text-slate-600" aria-hidden />
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {hint && <div className="max-w-sm text-xs text-slate-500">{hint}</div>}
      {action}
    </div>
  );
}

export function ErrorBanner({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-red-500/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div>
        <div className="font-medium">{title}</div>
        {detail && <div className="mt-0.5 text-red-200/80">{detail}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-ink-800 ${className}`} aria-hidden />;
}

export function LoadingGrid() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading data from SpacetimeDB">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`panel flex max-h-[92vh] w-full flex-col shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="panel-header">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button data-close className="text-slate-400 hover:text-slate-100" onClick={onClose} aria-label="Close dialog">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 space-y-3 overflow-y-auto p-4 text-sm text-slate-300">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-700 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
