import { memo } from 'react';
import { AlertOctagon, ArrowDownRight, Bot, CheckCircle2, ClipboardList, FilePlus2, FileSearch, Gavel, Gauge, Network, Radar, RotateCcw, RotateCw, ShieldAlert, ShieldCheck, StickyNote, TrendingUp, Wrench, Zap, type LucideIcon } from 'lucide-react';
import type { IncidentEvent, Asset } from '../types/domain';
import { fmtTime, humanize } from '../lib/format';

const ICON: Record<string, { icon: LucideIcon; tone: string }> = {
  incident_created: { icon: FilePlus2, tone: 'text-red-300' },
  asset_failure_detected: { icon: AlertOctagon, tone: 'text-red-400' },
  asset_marked_offline: { icon: ArrowDownRight, tone: 'text-slate-300' },
  asset_marked_degraded: { icon: ArrowDownRight, tone: 'text-amber-300' },
  dependency_impact_calculated: { icon: Network, tone: 'text-cyan-300' },
  severity_updated: { icon: Gauge, tone: 'text-red-300' },
  status_changed: { icon: ShieldAlert, tone: 'text-amber-300' },
  task_created: { icon: ClipboardList, tone: 'text-sky-300' },
  task_updated: { icon: ClipboardList, tone: 'text-sky-300' },
  decision_recorded: { icon: Gavel, tone: 'text-violet-300' },
  recovery_requested: { icon: Wrench, tone: 'text-amber-300' },
  recovery_approved: { icon: CheckCircle2, tone: 'text-emerald-300' },
  recovery_rejected: { icon: Wrench, tone: 'text-red-300' },
  asset_restored: { icon: CheckCircle2, tone: 'text-emerald-300' },
  incident_resolved: { icon: CheckCircle2, tone: 'text-emerald-400' },
  note_added: { icon: StickyNote, tone: 'text-slate-300' },
  fault_injected: { icon: Zap, tone: 'text-red-300' },
  environment_reset: { icon: RotateCcw, tone: 'text-cyan-300' },
  ai_investigation_requested: { icon: Bot, tone: 'text-violet-300' },
  ai_investigation_completed: { icon: Bot, tone: 'text-violet-300' },
  ai_investigation_failed: { icon: Bot, tone: 'text-red-300' },
  ai_recommendation_decided: { icon: Gavel, tone: 'text-violet-300' },
  asset_exposed: { icon: Radar, tone: 'text-violet-300' },
  asset_recovering: { icon: RotateCw, tone: 'text-sky-300' },
  asset_status_changed: { icon: AlertOctagon, tone: 'text-amber-300' },
  containment_applied: { icon: ShieldCheck, tone: 'text-cyan-300' },
  evidence_collected: { icon: FileSearch, tone: 'text-violet-300' },
  surge_escalated: { icon: TrendingUp, tone: 'text-red-300' },
};

export const Timeline = memo(function Timeline({
  events,
  assetById,
  showIncident = false,
  compact = false,
}: {
  events: readonly IncidentEvent[];
  assetById: Map<string, Asset>;
  showIncident?: boolean;
  compact?: boolean;
}) {
  return (
    <ol className="relative space-y-0" aria-label="Incident timeline">
      {events.map(ev => {
        const meta = ICON[ev.eventType] ?? { icon: Bot, tone: 'text-slate-300' };
        const Icon = meta.icon;
        const asset = ev.assetId ? assetById.get(ev.assetId) : undefined;
        return (
          <li key={String(ev.eventId)} className="relative flex gap-3 pb-3 pl-0.5 last:pb-0">
            <div className="flex flex-col items-center">
              <div className={`rounded-full border border-ink-600 bg-ink-850 p-1 ${meta.tone}`}>
                <Icon className="size-3.5" aria-hidden />
              </div>
              <div className="mt-1 w-px flex-1 bg-ink-700" />
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <time className="font-mono text-slate-500 tabular-nums">{fmtTime(ev.timestamp)}</time>
                <span className="font-semibold text-slate-300">{humanize(ev.eventType)}</span>
                {showIncident && <span className="font-mono text-slate-500">INC-{String(ev.incidentId)}</span>}
                <span className="text-slate-500">· {ev.actor ? ev.actorName : `⚙ ${ev.actorName}`}</span>
              </div>
              <p className="mt-0.5 text-sm text-slate-200">{ev.description}</p>
              {!compact && (asset || ev.metadata.length > 0) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {asset && <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-cyan-300">{asset.assetId}</span>}
                  {ev.metadata.map(m => (
                    <span key={m.key} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                      {m.key}={m.value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
});
