// Compact before/after dependency graph for the Decision Lab. Uses the same
// deterministic layout as the Digital Twin page so services sit in familiar places.
import { memo, useMemo } from 'react';
import type { Asset, Dependency } from '../../types/domain';
import { layoutTwin } from '../../lib/derive';
import type { AssetState, ImpactSnapshot } from '../../lib/engine';

export const STATE_STYLE: Record<AssetState, { fill: string; label: string }> = {
  offline: { fill: '#f87171', label: 'Offline' },
  degraded: { fill: '#fbbf24', label: 'Degraded' },
  recovering: { fill: '#38bdf8', label: 'Recovering' },
  exposed: { fill: '#a78bfa', label: 'At risk (exposed)' },
  healthy: { fill: '#34d399', label: 'Healthy' },
};

export function StateLegend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400" aria-label="Graph legend">
      {(Object.keys(STATE_STYLE) as AssetState[]).map(k => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-full" style={{ background: STATE_STYLE[k].fill }} /> {STATE_STYLE[k].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block size-2.5 rounded-full border-2 border-white" /> root cause
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block size-2.5 rounded-full border-2 border-dashed border-cyan-300" /> changed by this response
      </span>
    </div>
  );
}

export const ImpactGraph = memo(function ImpactGraph({
  title,
  assets,
  dependencies,
  snapshot,
  compareTo,
}: {
  title: string;
  assets: readonly Asset[];
  dependencies: readonly Dependency[];
  snapshot: ImpactSnapshot;
  /** When set, services whose state differs from this snapshot are outlined. */
  compareTo?: ImpactSnapshot;
}) {
  const pos = useMemo(() => layoutTwin(assets, dependencies), [assets, dependencies]);
  const pts = [...pos.values()];
  if (pts.length === 0) return <p className="text-xs text-slate-500">No services in the twin.</p>;
  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  const maxY = Math.max(...pts.map(p => p.y));
  const W = 560;
  const H = 300;
  const pad = 70;
  const sx = (x: number) => pad + ((x - minX) / Math.max(1, maxX - minX)) * (W - 2 * pad);
  const sy = (y: number) => 30 + ((y - minY) / Math.max(1, maxY - minY)) * (H - 50);
  const nameOf = new Map(assets.map(a => [a.assetId, a.name]));
  const changed = (id: string) => !!compareTo && compareTo.assets[id]?.state !== snapshot.assets[id]?.state;
  const impacted = Object.values(snapshot.assets).filter(a => a.state !== 'healthy').length;

  return (
    <figure className="min-w-0 rounded-md border border-ink-700 bg-ink-950 p-2">
      <figcaption className="flex items-center justify-between px-1 text-xs">
        <span className="font-semibold text-slate-200">{title}</span>
        <span className="text-slate-400">
          {impacted} of {assets.length} affected
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: ${impacted} of ${assets.length} services affected`}>
        {dependencies.map(d => {
          const a = pos.get(d.dependentAssetId);
          const b = pos.get(d.requiredAssetId);
          if (!a || !b) return null;
          const st = snapshot.assets[d.dependentAssetId];
          const hot = st && st.state !== 'healthy' && st.causedBy === d.requiredAssetId;
          return (
            <line
              key={`${d.dependentAssetId}>${d.requiredAssetId}`}
              x1={sx(a.x)}
              y1={sy(a.y)}
              x2={sx(b.x)}
              y2={sy(b.y)}
              stroke={hot ? STATE_STYLE[st.state].fill : '#334155'}
              strokeWidth={hot ? 2 : 1}
              strokeDasharray={d.dependencyType === 'noncritical' ? '5 4' : d.dependencyType === 'optional' ? '2 4' : undefined}
              opacity={hot ? 0.9 : 0.6}
            />
          );
        })}
        {[...pos.entries()].map(([id, p]) => {
          const st = snapshot.assets[id];
          const state = st?.state ?? 'healthy';
          const label = (nameOf.get(id) ?? id).replace(/ Service$/, '');
          return (
            <g key={id}>
              <title>{`${nameOf.get(id) ?? id}: ${STATE_STYLE[state].label}${st?.role === 'root' ? ' (root cause)' : ''}`}</title>
              {changed(id) && <circle cx={sx(p.x)} cy={sy(p.y)} r={13} fill="none" stroke="#67e8f9" strokeWidth={1.5} strokeDasharray="3 2" />}
              <circle cx={sx(p.x)} cy={sy(p.y)} r={8} fill={STATE_STYLE[state].fill} stroke={st?.role === 'root' ? '#ffffff' : '#0f172a'} strokeWidth={st?.role === 'root' ? 2.5 : 1} />
              <text x={sx(p.x)} y={sy(p.y) - 13} textAnchor="middle" fontSize="10" fill="#cbd5e1">
                {label.length > 18 ? `${label.slice(0, 17)}…` : label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
});
