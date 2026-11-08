// Gate for pages that need subscribed data. Never shows an endless skeleton:
// disconnected → explicit message + retry; slow subscription → message + retry.
import { useEffect, useState, type ReactNode } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useSentinel } from '../hooks/useSentinelData';
import { LoadingGrid } from './ui';

export const SLOW_SUBSCRIPTION_MS = 10_000;

function Retry({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="alert" className="panel flex flex-col items-center gap-3 px-6 py-12 text-center">
      <WifiOff className="size-8 text-red-300" aria-hidden />
      <div className="text-sm font-medium text-slate-100">{title}</div>
      <p className="max-w-md text-xs text-slate-400">{detail}</p>
      <button className="btn-ghost" onClick={() => window.location.reload()}>
        <RefreshCw className="size-4" /> Retry connection
      </button>
    </div>
  );
}

export function PageGate({ children }: { children: ReactNode }) {
  const { isActive } = useSpacetimeDB();
  const { ready } = useSentinel();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_SUBSCRIPTION_MS);
    return () => window.clearTimeout(t);
  }, [ready]);

  if (ready) return <>{children}</>;
  if (!isActive) {
    return <Retry title="Connection to SpacetimeDB lost. Live actions are unavailable until reconnection." detail="The client retries automatically. Check that `spacetime start` is running and the `sentinelos-x` module is published, then retry." />;
  }
  if (slow) {
    return <Retry title="Still waiting for live data from SpacetimeDB" detail="Connected, but the initial subscription has not completed. The module may still be publishing or the server is busy." />;
  }
  return <LoadingGrid />;
}
