import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Expand, Maximize2, RotateCcw, Search, Tags, ZoomIn, ZoomOut } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { layoutTwin } from '../../lib/derive';
import { classifyEdge, deriveBlast, type EdgeClass } from '../../lib/blast';
import { HEALTH_FILTERS, assetTypes, filterAssets, isFilterActive, type HealthFilter, type TwinFilter } from '../../lib/twinFilters';
import { EmptyState, Panel } from '../../components/ui';
import { HEALTH_META } from '../../components/StatusBadge';
import { PageGate } from '../../components/PageGate';
import { BlastRadiusPanel } from '../incidents/BlastRadiusPanel';
import { AssetNode, type AssetFlowNode } from './AssetNode';
import { AssetDetailPanel } from './AssetDetailPanel';
import { humanize } from '../../lib/format';

const nodeTypes = { asset: AssetNode };
const EDGE_DASH: Record<string, string | undefined> = { required: undefined, noncritical: '6 4', optional: '2 4' };
const EDGE_STYLE: Record<EdgeClass, { color?: string; width: number; dash?: string }> = {
  normal: { width: 1.3 },
  direct: { color: '#f87171', width: 2.6 },
  indirect: { color: '#fbbf24', width: 2, dash: '8 4' },
  exposure: { color: '#a78bfa', width: 1.8, dash: '2 5' },
};
const FILTER_LABEL: Record<HealthFilter, string> = { healthy: 'Healthy', degraded: 'Degraded', critical: 'Critical', offline: 'Offline', recovering: 'Recovering', at_risk: 'At risk' };

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-400" aria-label="Graph legend">
      {(['healthy', 'degraded', 'critical', 'offline', 'recovering'] as const).map(h => {
        const M = HEALTH_META[h];
        return (
          <span key={h} className="inline-flex items-center gap-1">
            <M.icon className="size-3" />
            <span className="inline-block size-2 rounded-sm" style={{ background: M.hex }} /> {h}
          </span>
        );
      })}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block size-2 rounded-sm bg-violet-400" /> at risk (exposed)
      </span>
      <span className="text-slate-600">|</span>
      {(
        [
          ['direct', 'directly affected dependency'],
          ['indirect', 'indirect (cascade)'],
          ['exposure', 'exposure path'],
        ] as const
      ).map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1">
          <svg width="26" height="6" aria-hidden>
            <line x1="0" y1="3" x2="26" y2="3" stroke={EDGE_STYLE[k].color} strokeWidth="2.4" strokeDasharray={EDGE_STYLE[k].dash} />
          </svg>
          {label}
        </span>
      ))}
      <span className="text-slate-600">|</span>
      <span>arrow A → B: “A depends on B”</span>
    </div>
  );
}

function TwinCanvas() {
  const { assets, dependencies, assetById, metricsByAsset, telemetryByAsset, activeIncidentsByAsset, incidents, incidentAssets, effects } = useSentinel();
  const rf = useReactFlow();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<TwinFilter>({ query: '', health: new Set(), assetType: '' });
  const [showLabels, setShowLabels] = useState(false);
  const [overlay, setOverlay] = useState<string>(''); // '' = global view, else incident id
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  // Layout depends only on structure (ids + edges), so health updates never move nodes.
  const structureKey = useMemo(
    () => `${assets.map(a => a.assetId).sort().join(',')}#${dependencies.map(d => `${d.dependentAssetId}>${d.requiredAssetId}`).sort().join(',')}`,
    [assets, dependencies]
  );
  const latest = useRef({ assets, dependencies });
  latest.current = { assets, dependencies };
  const positions = useMemo(() => layoutTwin(latest.current.assets, latest.current.dependencies), [structureKey]);

  const activeIncidents = useMemo(() => incidents.filter(i => i.status !== 'resolved').sort((a, b) => (a.incidentId < b.incidentId ? 1 : -1)), [incidents]);
  const overlayIncident = activeIncidents.find(i => String(i.incidentId) === overlay);
  useEffect(() => {
    if (overlay && !overlayIncident) setOverlay('');
  }, [overlay, overlayIncident]);
  const blast = useMemo(
    () => (overlayIncident ? deriveBlast(overlayIncident.incidentId, incidentAssets, effects, dependencies, assetById) : null),
    [overlayIncident, incidentAssets, effects, dependencies, assetById]
  );
  const overlayRole = useMemo(() => new Map(blast?.entries.map(e => [e.assetId, e]) ?? []), [blast]);

  const matches = useMemo(() => filterAssets(assets, filter), [assets, filter]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const filtering = isFilterActive(filter);

  const nodes = useMemo<AssetFlowNode[]>(
    () =>
      assets.map(a => {
        const m = metricsByAsset.get(a.assetId);
        const latency = m?.at(-1)?.latencyMs ?? telemetryByAsset.get(a.assetId)?.at(-1)?.latencyMs;
        const role = overlayRole.get(a.assetId)?.group;
        return {
          id: a.assetId,
          type: 'asset',
          position: dragged[a.assetId] ?? positions.get(a.assetId) ?? { x: 0, y: 0 },
          selected: a.assetId === selected,
          data: {
            asset: a,
            latencyMs: latency,
            incidentCount: activeIncidentsByAsset.get(a.assetId)?.length ?? 0,
            dimmed: (filtering && !matchSet.has(a.assetId)) || (!!overlayIncident && !role),
            overlay: role,
          },
        };
      }),
    [assets, metricsByAsset, telemetryByAsset, overlayRole, dragged, positions, selected, activeIncidentsByAsset, filtering, matchSet, overlayIncident]
  );

  const edges = useMemo<Edge[]>(() => {
    const ovRows = new Map(blast?.entries.map(e => [e.assetId, e]) ?? []);
    return dependencies.map(d => {
      let cls: EdgeClass;
      if (blast) {
        const dep = ovRows.get(d.dependentAssetId);
        const req = ovRows.get(d.requiredAssetId);
        cls = dep
          ? classifyEdge({ status: dep.status, causedBy: dep.causedBy, exposedFrom: dep.group === 'exposed' ? dep.causedBy : null }, d.requiredAssetId, req?.group === 'root', !!req)
          : 'normal';
      } else {
        const dep = assetById.get(d.dependentAssetId);
        const req = assetById.get(d.requiredAssetId);
        cls = dep
          ? classifyEdge(
              { status: dep.impactType === 'cascade' ? dep.operationalStatus : dep.impactType === 'exposed' ? 'exposed' : null, causedBy: dep.impactType === 'cascade' ? (dep.impactCausedBy ?? null) : null, exposedFrom: dep.impactType === 'exposed' ? (dep.impactCausedBy ?? null) : null },
              d.requiredAssetId,
              req?.impactType === 'direct',
              !!req && req.impactType !== 'none'
            )
          : 'normal';
      }
      const st = EDGE_STYLE[cls];
      const color = st.color ?? '#3b5272';
      const dimmed = (filtering && !(matchSet.has(d.dependentAssetId) && matchSet.has(d.requiredAssetId))) || (!!blast && cls === 'normal');
      return {
        id: String(d.dependencyId),
        source: d.dependentAssetId,
        target: d.requiredAssetId,
        animated: false,
        className: `edge-${cls}`,
        style: { stroke: color, strokeWidth: st.width, strokeDasharray: st.dash ?? EDGE_DASH[d.dependencyType], opacity: dimmed ? 0.2 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        label: showLabels ? d.dependencyType : undefined,
        labelStyle: { fill: '#94a3b8', fontSize: 10 },
        labelBgStyle: { fill: '#050a14' },
        ariaLabel: `${assetById.get(d.dependentAssetId)?.name ?? d.dependentAssetId} depends on ${assetById.get(d.requiredAssetId)?.name ?? d.requiredAssetId} (${d.dependencyType}${cls !== 'normal' ? `, ${cls}` : ''})`,
      };
    });
  }, [dependencies, blast, assetById, filtering, matchSet, showLabels]);

  const onNodesChange = useCallback((changes: NodeChange<AssetFlowNode>[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        const p = c.position;
        setDragged(d => ({ ...d, [c.id]: p }));
      } else if (c.type === 'select') {
        if (c.selected) setSelected(c.id);
        else setSelected(s => (s === c.id ? null : s));
      }
    }
  }, []);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      const p = dragged[id] ?? positions.get(id);
      if (p) void rf.setCenter(p.x + 112, p.y + 50, { zoom: Math.max(rf.getZoom(), 0.9), duration: 250 });
    },
    [dragged, positions, rf]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && !typing) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleHealth = (h: HealthFilter) =>
    setFilter(f => {
      const next = new Set(f.health);
      if (next.has(h)) next.delete(h);
      else next.add(h);
      return { ...f, health: next };
    });
  const types = useMemo(() => assetTypes(assets), [assets]);
  const selAsset = selected ? assetById.get(selected) : undefined;

  if (assets.length === 0) {
    return (
      <Panel>
        <EmptyState title="No virtual infrastructure is loaded. Initialize the demo environment." hint="An Incident Commander can initialize it from Settings → Environment." />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <div className="panel flex flex-wrap items-end gap-3 p-3" role="search" aria-label="Search and filter services">
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">Search services</span>
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-500" aria-hidden />
          <input
            ref={searchRef}
            className="input pl-8"
            placeholder="Search services (press /)"
            value={filter.query}
            onChange={e => setFilter(f => ({ ...f, query: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter' && matches[0]) select(matches[0]);
              if (e.key === 'Escape') setFilter(f => ({ ...f, query: '' }));
            }}
            aria-describedby="twin-match-count"
          />
        </label>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by health">
          {HEALTH_FILTERS.map(h => (
            <button
              key={h}
              className={`rounded-full border px-2.5 py-1 text-xs ${filter.health.has(h) ? 'border-cyan-400 bg-cyan-500/15 text-cyan-100' : 'border-ink-600 text-slate-300 hover:bg-ink-800'}`}
              aria-pressed={filter.health.has(h)}
              onClick={() => toggleHealth(h)}
            >
              {FILTER_LABEL[h]}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Type
          <select className="input w-40 py-1.5" aria-label="Type" value={filter.assetType} onChange={e => setFilter(f => ({ ...f, assetType: e.target.value }))}>
            <option value="">All types</option>
            {types.map(t => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Blast radius
          <select className="input w-56 py-1.5" aria-label="Blast radius" value={overlay} onChange={e => setOverlay(e.target.value)}>
            <option value="">All incidents (live state)</option>
            {activeIncidents.map(i => (
              <option key={String(i.incidentId)} value={String(i.incidentId)}>
                INC-{String(i.incidentId)} · {i.title.slice(0, 34)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-1" role="toolbar" aria-label="Graph view controls">
          <button className="btn-ghost px-2" onClick={() => void rf.zoomIn({ duration: 150 })} aria-label="Zoom in" title="Zoom in">
            <ZoomIn className="size-4" />
          </button>
          <button className="btn-ghost px-2" onClick={() => void rf.zoomOut({ duration: 150 })} aria-label="Zoom out" title="Zoom out">
            <ZoomOut className="size-4" />
          </button>
          <button className="btn-ghost px-2" onClick={() => void rf.fitView({ padding: 0.15, duration: 200 })} aria-label="Fit to screen" title="Fit to screen">
            <Maximize2 className="size-4" />
          </button>
          <button
            className="btn-ghost px-2"
            onClick={() => {
              setDragged({});
              setSelected(null);
              window.setTimeout(() => void rf.fitView({ padding: 0.15, duration: 200 }), 0);
            }}
            aria-label="Reset view and layout"
            title="Reset view and layout"
          >
            <RotateCcw className="size-4" />
          </button>
          <button className={`btn-ghost px-2 ${showLabels ? 'border-cyan-500 text-cyan-200' : ''}`} onClick={() => setShowLabels(v => !v)} aria-pressed={showLabels} aria-label="Toggle dependency labels" title="Toggle dependency labels">
            <Tags className="size-4" />
          </button>
        </div>
        <span id="twin-match-count" className="w-full text-[11px] text-slate-500" aria-live="polite">
          {filtering ? `${matches.length} of ${assets.length} services match${matches.length && filter.query ? ' — Enter selects the first' : ''}` : `${assets.length} services · drag to rearrange · / to search · Esc to close details`}
        </span>
      </div>
      <Legend />
      <div className="grid gap-4 lg:grid-cols-[1fr_23rem]">
        <Panel bodyClass="h-full p-0" className="h-[62vh] min-h-[460px]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.25}
            maxZoom={1.8}
            nodesConnectable={false}
            nodesFocusable
            colorMode="dark"
            aria-label="Digital twin dependency graph"
          >
            <Background color="#132033" gap={24} />
          </ReactFlow>
        </Panel>
        <div className="min-h-0 space-y-3 lg:h-[62vh] lg:min-h-[460px]">
          {selAsset ? (
            <AssetDetailPanel asset={selAsset} onClose={() => setSelected(null)} onSelect={select} />
          ) : (
            <>
              {blast && overlayIncident && <BlastRadiusPanel incident={overlayIncident} summary={blast} compact onSelectAsset={select} />}
              <Panel title={<span className="inline-flex items-center gap-1.5"><Expand className="size-3.5" /> Services ({matches.length})</span>} bodyClass="max-h-[50vh] overflow-y-auto p-1">
                <ul aria-label="Services">
                  {matches.map(id => {
                    const a = assetById.get(id)!;
                    return (
                      <li key={id}>
                        <button className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-ink-800 focus-visible:bg-ink-800" onClick={() => select(id)}>
                          <span className="truncate">{a.name}</span>
                          <span className="shrink-0" style={{ color: a.impactType === 'exposed' ? '#a78bfa' : HEALTH_META[a.healthStatus]?.hex }}>
                            {a.impactType === 'exposed' && a.healthStatus === 'healthy' ? 'at risk' : a.healthStatus}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {matches.length === 0 && <EmptyState title="No services match these filters" />}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function DigitalTwinPage() {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-50">Digital twin</h1>
        <p className="text-sm text-slate-400">Live virtual infrastructure from SpacetimeDB. Select a service to inspect it. All infrastructure and telemetry are synthetic.</p>
      </div>
      <PageGate>
        <ReactFlowProvider>
          <TwinCanvas />
        </ReactFlowProvider>
      </PageGate>
    </div>
  );
}
