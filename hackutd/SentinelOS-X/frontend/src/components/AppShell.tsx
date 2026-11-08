import { NavLink, Outlet } from 'react-router-dom';
import { useSpacetimeDB } from 'spacetimedb/react';
import { useEffect, useState } from 'react';
import { Activity, Bot, Cpu, FlaskConical, LayoutDashboard, Network, Radio, Settings, Shield, Siren, Wifi, WifiOff, Loader2, RefreshCw } from 'lucide-react';
import { useSentinel } from '../hooks/useSentinelData';
import { ROLE_LABEL, type Role } from '../types/domain';
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_HOST } from '../services/spacetime';
import { ErrorBanner } from './ui';
import { RegisterPanel } from './RegisterPanel';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/twin', label: 'Digital Twin', icon: Network },
  { to: '/incidents', label: 'Incidents', icon: Siren },
  { to: '/command', label: 'Incident Command', icon: Radio },
  { to: '/ai', label: 'AI Investigator', icon: Bot },
  { to: '/lab', label: 'Decision Lab', icon: FlaskConical },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function ConnectionIndicator() {
  const { isActive, connectionError } = useSpacetimeDB();
  const { ready } = useSentinel();
  if (isActive && ready)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300" title={`${SPACETIMEDB_HOST} / ${SPACETIMEDB_DB_NAME}`}>
        <Wifi className="size-3.5" aria-hidden /> Live · SpacetimeDB
      </span>
    );
  if (isActive)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-cyan-300">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Syncing subscriptions…
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-red-300" title={connectionError?.message}>
      <WifiOff className="size-3.5" aria-hidden /> Disconnected
    </span>
  );
}

/** Built-in simulation engine heartbeat (synthetic telemetry). Stale if no tick for 3 intervals. */
function EngineIndicator() {
  const { simulation } = useSentinel();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(t);
  }, []);
  if (!simulation) return <span className="hidden text-xs text-slate-500 sm:inline">Sim engine: not initialized</span>;
  const last = simulation.lastTickAt?.toDate().getTime();
  const stale = !last || now - last > simulation.intervalMs * 3 + 2000;
  const label = !simulation.telemetryEnabled ? 'telemetry off' : stale ? 'waiting for tick' : `tick #${String(simulation.tickCount)}`;
  const tone = !simulation.telemetryEnabled ? 'text-slate-500' : stale ? 'text-amber-300' : 'text-violet-300';
  return (
    <span className={`hidden items-center gap-1 text-xs sm:inline-flex ${tone}`} title="Built-in simulation engine — all telemetry is synthetic">
      <Cpu className="size-3.5" aria-hidden /> Synthetic telemetry: {label}
    </span>
  );
}

function ServiceIndicators() {
  const { services } = useSentinel();
  const chip = (kind: string, label: string, Icon: typeof Activity) => {
    const s = services.find(x => x.kind === kind && x.status !== 'revoked');
    // The sensor gateway talks to SpacetimeDB over short HTTP calls, so `online` is only true during a call.
    // Treat it as online while it has reported within the last 20 s (lastSeenAt is updated on every reading).
    const recentHttp = kind === 'hardware_gateway' && !!s && Date.now() - Number(s.lastSeenAt.microsSinceUnixEpoch / 1000n) < 20_000;
    const state = !s ? 'not connected' : s.status === 'pending' ? 'awaiting authorization' : s.online || recentHttp ? 'online' : 'offline';
    const tone = state === 'online' ? 'text-emerald-300' : state === 'awaiting authorization' ? 'text-amber-300' : 'text-slate-500';
    return (
      <span className={`hidden items-center gap-1 text-xs sm:inline-flex ${tone}`} title={`${label}: ${state}`}>
        <Icon className="size-3.5" aria-hidden /> {label}: {state}
      </span>
    );
  };
  const external = services.some(x => x.kind === 'telemetry');
  return (
    <div className="flex items-center gap-4">
      <EngineIndicator />
      {external && chip('telemetry', 'External telemetry', Activity)}
      {chip('hardware_gateway', 'Sensor gateway', Activity)}
      {chip('ai_agent', 'Nemotron agent', Bot)}
    </div>
  );
}

export function AppShell() {
  const { isActive, connectionError, identity } = useSpacetimeDB();
  const { me, incidents, ready } = useSentinel();
  const activeCount = incidents.filter(i => i.status !== 'resolved').length;

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-900 md:flex">
        <div className="flex items-center gap-2.5 border-b border-ink-700 px-4 py-4">
          <Shield className="size-6 text-cyan-400" aria-hidden />
          <div>
            <div className="text-sm font-bold tracking-wide text-slate-50">SentinelOS X</div>
            <div className="text-[10px] tracking-[0.18em] text-slate-500 uppercase">Incident Command</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2" aria-label="Main">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive: a }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${a ? 'bg-cyan-500/10 text-cyan-200' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200'}`
              }
            >
              <n.icon className="size-4" aria-hidden />
              <span className="flex-1">{n.label}</span>
              {n.to === '/incidents' && activeCount > 0 && (
                <span className="rounded bg-red-500/20 px-1.5 text-[11px] font-semibold text-red-300" aria-label={`${activeCount} active incidents`}>
                  {activeCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-ink-700 p-3 text-[11px] leading-relaxed text-slate-500">
          Local development build. Infrastructure and most telemetry are synthetic; the Sentinel sensor node reports real measurements. Not a production security control.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 bg-ink-900/60 px-4 py-2.5">
          <nav className="flex gap-1 md:hidden" aria-label="Main (mobile)">
            {NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive: a }) => `rounded p-1.5 ${a ? 'text-cyan-300' : 'text-slate-400'}`} aria-label={n.label}>
                <n.icon className="size-4" />
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-4">
            <ConnectionIndicator />
            <ServiceIndicators />
          </div>
          <div className="flex items-center gap-3 text-xs">
            {me ? (
              <span className="text-slate-300">
                {me.displayName} · <span className="text-cyan-300">{ROLE_LABEL[me.role as Role] ?? me.role}</span>
              </span>
            ) : (
              <span className="text-slate-500">Not registered</span>
            )}
            {identity && <span className="hidden font-mono text-slate-600 lg:inline" title="Your SpacetimeDB identity (this tab)">{identity.toHexString().slice(0, 10)}…</span>}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="mx-auto max-w-[1600px] space-y-4">
            {!isActive && (
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-64 flex-1">
                  <ErrorBanner
                    title="Connection to SpacetimeDB lost. Live actions are unavailable until reconnection."
                    detail={`${connectionError?.message ?? 'Attempting to connect'} — ${SPACETIMEDB_HOST} / ${SPACETIMEDB_DB_NAME}. Any data shown may be stale; the client keeps retrying automatically.`}
                  />
                </div>
                <button className="btn-ghost" onClick={() => window.location.reload()}>
                  <RefreshCw className="size-4" /> Retry now
                </button>
              </div>
            )}
            {isActive && ready && !me && <RegisterPanel />}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
