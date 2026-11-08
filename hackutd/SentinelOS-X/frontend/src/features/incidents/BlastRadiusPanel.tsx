import { ArrowRight, Radar, Target } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Incident } from '../../types/domain';
import type { BlastEntry, BlastGroup, BlastSummary } from '../../lib/blast';
import { Panel } from '../../components/ui';
import { humanize } from '../../lib/format';

const GROUP: Record<BlastGroup, { label: string; cls: string; hint: string }> = {
  root: { label: 'Root', cls: 'text-red-300', hint: 'Confirmed affected (origin)' },
  direct: { label: 'Direct', cls: 'text-amber-300', hint: 'One dependency hop from the root' },
  indirect: { label: 'Indirect', cls: 'text-orange-300', hint: 'Two or more hops (cascade)' },
  exposed: { label: 'Exposed', cls: 'text-violet-300', hint: 'Potentially exposed via trust — not confirmed' },
};

function Stat({ label, value, tone = 'text-slate-50' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2">
      <div className="text-[10px] tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function PathChips({ e, name, onSelect }: { e: BlastEntry; name: (id: string) => string; onSelect?: (id: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label={`Dependency path to ${e.name}`}>
      {e.path.map((id, i) => (
        <span key={`${id}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowRight className="size-3 text-slate-600" aria-hidden />}
          {onSelect ? (
            <button className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 hover:bg-ink-700" onClick={() => onSelect(id)}>
              {name(id)}
            </button>
          ) : (
            <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">{name(id)}</span>
          )}
        </span>
      ))}
    </div>
  );
}

export function BlastRadiusPanel({
  incident,
  summary,
  compact = false,
  onSelectAsset,
}: {
  incident: Incident;
  summary: BlastSummary;
  compact?: boolean;
  onSelectAsset?: (id: string) => void;
}) {
  const name = (id: string) => summary.entries.find(x => x.assetId === id)?.name ?? id;
  const current = summary.entries.filter(e => e.current);
  const recovered = summary.entries.filter(e => !e.current);
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <Radar className="size-3.5" /> Blast radius{compact ? ` · INC-${incident.incidentId}` : ''}
        </span>
      }
      bodyClass={compact ? 'max-h-[40vh] overflow-y-auto p-3' : 'p-4'}
    >
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Blast radius summary">
        <Stat label="Affected" value={summary.total} />
        <Stat label="Direct" value={summary.direct} tone="text-amber-300" />
        <Stat label="Indirect" value={summary.indirect} tone="text-orange-300" />
        <Stat label="Exposed" value={summary.exposed} tone="text-violet-300" />
        <Stat label="Max depth" value={summary.maxDepth} />
        <Stat label="Critical svcs" value={summary.criticalAffected.length} tone={summary.criticalAffected.length ? 'text-red-300' : 'text-slate-50'} />
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Computed by the SpacetimeDB engine from the dependency graph; this view only groups the recorded result.</p>
      {current.length === 0 ? (
        <p className="mt-3 text-xs text-emerald-300">No services are currently affected by this incident.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {current.map(e => (
            <li key={e.assetId} className="text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1 font-semibold ${GROUP[e.group].cls}`} title={GROUP[e.group].hint}>
                  {e.group === 'root' && <Target className="size-3" aria-hidden />}
                  {GROUP[e.group].label}
                </span>
                {onSelectAsset ? (
                  <button className="font-medium text-slate-100 hover:text-cyan-300" onClick={() => onSelectAsset(e.assetId)}>
                    {e.name}
                  </button>
                ) : (
                  <span className="font-medium text-slate-100">{e.name}</span>
                )}
                <span className="text-slate-500">
                  {humanize(e.status)} · depth {e.depth} · {humanize(e.criticality)}
                </span>
              </div>
              <div className="mt-0.5 text-slate-400">{e.reason}</div>
              {!compact && e.path.length > 1 && <div className="mt-1"><PathChips e={e} name={name} onSelect={onSelectAsset} /></div>}
            </li>
          ))}
        </ul>
      )}
      {!compact && recovered.length > 0 && (
        <p className="mt-3 text-[11px] text-slate-500">Previously affected, now recovered: {recovered.map(e => e.name).join(', ')}</p>
      )}
      {compact && (
        <Link to={`/incidents/${incident.incidentId}`} className="mt-2 inline-block text-xs text-cyan-300 hover:underline">
          Open incident →
        </Link>
      )}
    </Panel>
  );
}
