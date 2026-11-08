// Status indicators always pair color with an icon and text label, so state is
// never conveyed by color alone.
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleSlash, Info, ShieldAlert, Activity, Clock, RotateCw, Radar, Radio } from 'lucide-react';
import { INCIDENT_STATUS_LABEL } from '../types/domain';
import type { ComponentType } from 'react';
import { humanize } from '../lib/format';

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'cyan' | 'violet';

const TONE: Record<Tone, string> = {
  green: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  amber: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  red: 'bg-red-500/10 text-red-300 ring-red-500/30',
  blue: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
  slate: 'bg-slate-500/10 text-slate-300 ring-slate-500/30',
  cyan: 'bg-cyan-500/10 text-cyan-300 ring-cyan-500/30',
  violet: 'bg-violet-500/10 text-violet-300 ring-violet-500/30',
};

function Badge({ tone, icon: Icon, label }: { tone: Tone; icon: ComponentType<{ className?: string }>; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase ring-1 ring-inset ${TONE[tone]}`}>
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

export const HEALTH_META: Record<string, { tone: Tone; icon: ComponentType<{ className?: string }>; hex: string }> = {
  healthy: { tone: 'green', icon: CheckCircle2, hex: '#34d399' },
  degraded: { tone: 'amber', icon: AlertTriangle, hex: '#fbbf24' },
  critical: { tone: 'red', icon: AlertOctagon, hex: '#f87171' },
  offline: { tone: 'slate', icon: CircleSlash, hex: '#94a3b8' },
  recovering: { tone: 'blue', icon: RotateCw, hex: '#60a5fa' },
};

export function HealthBadge({ status }: { status: string }) {
  const m = HEALTH_META[status] ?? HEALTH_META.offline;
  return <Badge tone={m.tone} icon={m.icon} label={status} />;
}

const SEVERITY: Record<string, { tone: Tone; icon: ComponentType<{ className?: string }> }> = {
  low: { tone: 'blue', icon: Info },
  medium: { tone: 'amber', icon: AlertTriangle },
  high: { tone: 'red', icon: ShieldAlert },
  critical: { tone: 'red', icon: AlertOctagon },
};

export function SeverityBadge({ severity }: { severity: string }) {
  const m = SEVERITY[severity] ?? SEVERITY.low;
  return <Badge tone={m.tone} icon={m.icon} label={`Sev ${severity}`} />;
}

const STATUS: Record<string, Tone> = {
  open: 'red',
  investigating: 'amber',
  contained: 'cyan',
  recovering: 'violet',
  resolved: 'green',
  todo: 'slate',
  in_progress: 'cyan',
  blocked: 'red',
  done: 'green',
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
  adopted: 'green',
  withdrawn: 'slate',
  requested: 'amber',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS[status] ?? 'slate';
  const icon = status === 'resolved' || status === 'done' || status === 'approved' || status === 'adopted' || status === 'completed' ? CheckCircle2 : status === 'pending' ? Clock : Activity;
  return <Badge tone={tone} icon={icon} label={INCIDENT_STATUS_LABEL[status] ?? humanize(status)} />;
}

/** "At risk": potentially exposed through a trust dependency (not confirmed compromised). */
export function ExposureBadge() {
  return <Badge tone="violet" icon={Radar} label="At risk" />;
}

export function SimBadge() {
  return <Badge tone="violet" icon={Info} label="Simulation" />;
}

/** A real incident, opened from measured hardware data (isSimulation = false). */
export function RealBadge() {
  return <Badge tone="green" icon={Radio} label="Real event" />;
}
