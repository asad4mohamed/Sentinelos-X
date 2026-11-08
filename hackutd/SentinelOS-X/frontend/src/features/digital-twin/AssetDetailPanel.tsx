import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Zap } from 'lucide-react';
import type { Asset } from '../../types/domain';
import { CAN, type Role } from '../../types/domain';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { chronological, dependentsOf, explainImpact, requirementsOf } from '../../lib/derive';
import { ExposureBadge, HealthBadge, SeverityBadge, StatusBadge } from '../../components/StatusBadge';
import { fmtDateTime, fmtTime, humanize, relTime } from '../../lib/format';
import { Sparkline } from '../../components/Sparkline';
import { ResponseControls } from '../../components/ResponseControls';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1 text-xs">
      <dt className="text-slate-500">{k}</dt>
      <dd className="min-w-0 text-slate-200">{children}</dd>
    </div>
  );
}

function SensorSection({ assetId }: { assetId: string }) {
  const { sensorNodes, readingsByNode } = useSentinel();
  const node = sensorNodes.find(n => n.assetId === assetId);
  const readings = node ? (readingsByNode.get(node.nodeId) ?? []).slice(-60) : [];
  return (
    <section aria-label="Sensor readings">
      <h3 className="panel-title mb-1.5">
        Sensor readings <span className="normal-case tracking-normal text-emerald-300">· real measurements</span>
      </h3>
      {!node || readings.length === 0 ? (
        <p className="text-xs text-slate-500">No readings yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Sparkline label="Temperature" values={readings.map(r => r.tempC)} color="#22d3ee" format={v => `${v.toFixed(1)} °C`} />
          <Sparkline label="Humidity" values={readings.map(r => r.humidityPct)} color="#34d399" format={v => `${v.toFixed(0)}%`} />
          <p className="col-span-2 text-[11px] text-slate-500">
            {node.sensorModel} · node {node.nodeId} · limits {node.tempLimitC} °C / {node.humidityLimitPct}% · measured, not simulated
          </p>
        </div>
      )}
    </section>
  );
}

function TelemetrySection({ assetId }: { assetId: string }) {
  const { metricsByAsset, telemetryByAsset, simulation, assetById } = useSentinel();
  if (assetById.get(assetId)?.assetType === 'environment_sensor') return <SensorSection assetId={assetId} />;
  const metrics = metricsByAsset.get(assetId) ?? [];
  const legacy = telemetryByAsset.get(assetId) ?? [];
  return (
    <section aria-label="Telemetry">
      <h3 className="panel-title mb-1.5">
        Telemetry <span className="normal-case tracking-normal text-violet-300">· synthetic</span>
      </h3>
      {metrics.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Sparkline label="CPU" values={metrics.map(s => s.cpuPct)} color="#fbbf24" format={v => `${v.toFixed(0)}%`} />
          <Sparkline label="Memory" values={metrics.map(s => (s.memoryPct < 0 ? 0 : s.memoryPct))} color="#a78bfa" format={v => `${v.toFixed(0)}%`} />
          <Sparkline label="Requests" values={metrics.map(s => s.requestRpm)} color="#34d399" format={v => `${v.toFixed(0)}/min`} />
          <Sparkline label="Error rate" values={metrics.map(s => s.errorRate * 100)} color="#f87171" format={v => `${v.toFixed(1)}%`} />
          <Sparkline label="Latency" values={metrics.map(s => s.latencyMs)} color="#22d3ee" format={v => `${v.toFixed(0)} ms`} />
          <Sparkline label="Connections" values={metrics.map(s => (s.connections < 0 ? 0 : s.connections))} color="#60a5fa" format={v => v.toFixed(0)} />
          <p className="col-span-2 text-[11px] text-slate-500">
            {metrics.length} samples · last {relTime(metrics[metrics.length - 1]!.timestamp)} · source {metrics[metrics.length - 1]!.source.replace('_', ' ')}
          </p>
        </div>
      ) : legacy.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Sparkline label="Latency" values={legacy.map(s => s.latencyMs)} color="#22d3ee" format={v => `${v.toFixed(0)} ms`} />
          <Sparkline label="Error rate" values={legacy.map(s => s.errorRate * 100)} color="#f87171" format={v => `${v.toFixed(1)}%`} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          No samples yet.{' '}
          {simulation && !simulation.telemetryEnabled ? 'Built-in telemetry is disabled in Settings.' : 'The simulation engine writes a sample every few seconds.'}
        </p>
      )}
    </section>
  );
}

export function AssetDetailPanel({ asset, onClose, onSelect }: { asset: Asset; onClose: () => void; onSelect: (id: string) => void }) {
  const { dependencies, assetById, incidentAssets, incidents, me, events, effects, activeIncidentsByAsset, evidence } = useSentinel();
  const { run, pending, connected } = useAction();
  const [reason, setReason] = useState('');
  const requires = requirementsOf(asset.assetId, dependencies);
  const dependents = dependentsOf(asset.assetId, dependencies);
  const related = incidentAssets.filter(ia => ia.assetId === asset.assetId).sort((a, b) => (a.incidentId < b.incidentId ? 1 : -1));
  const activeSims = incidents.filter(i => i.isSimulation && i.status !== 'resolved').sort((a, b) => (a.incidentId < b.incidentId ? 1 : -1));
  const [injectInto, setInjectInto] = useState<string>('');
  useEffect(() => setInjectInto(''), [asset.assetId]);
  const target = activeSims.find(i => String(i.incidentId) === injectInto) ?? activeSims[0];
  const role = me?.role as Role | undefined;
  const canInject = !!role && CAN.injectFault.includes(role);
  const rootIncidents = [...new Set(effects.filter(e => e.assetId === asset.assetId).map(e => e.incidentId))]
    .map(id => incidents.find(i => i.incidentId === id))
    .filter((i): i is NonNullable<typeof i> => !!i && i.status !== 'resolved');
  const recent = useMemo(() => chronological(events.filter(e => e.assetId === asset.assetId)).slice(-8).reverse(), [events, asset.assetId]);
  const activeCount = activeIncidentsByAsset.get(asset.assetId)?.length ?? 0;
  const explanations = useMemo(
    () => explainImpact(asset.assetId, { incidents, incidentAssets, dependencies, effects, nameOf: id => assetById.get(id)?.name ?? id }),
    [asset.assetId, incidents, incidentAssets, dependencies, effects, assetById]
  );
  const myEvidence = useMemo(() => {
    const open = new Set(explanations.map(x => x.incidentId));
    return evidence.filter(e => e.assetId === asset.assetId && open.has(e.incidentId)).slice(-6);
  }, [evidence, asset.assetId, explanations]);

  const link = (id: string) => (
    <button className="text-cyan-300 hover:underline" onClick={() => onSelect(id)}>
      {assetById.get(id)?.name ?? id}
    </button>
  );
  const impact =
    asset.impactType === 'none' ? (
      'None'
    ) : asset.impactType === 'direct' ? (
      'Root cause (confirmed)'
    ) : asset.impactType === 'exposed' ? (
      <>Potentially exposed via {link(asset.impactCausedBy ?? '')} — not confirmed compromised</>
    ) : (
      <>Dependency impact via {link(asset.impactCausedBy ?? '')}</>
    );

  return (
    <aside className="panel flex h-full flex-col" aria-label={`Details for ${asset.name}`}>
      <div className="panel-header">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-50">{asset.name}</h2>
          <p className="font-mono text-[11px] text-slate-500">{asset.assetId}</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-ink-800 hover:text-slate-100" aria-label="Close details">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p className="text-xs text-slate-400">{asset.description}</p>
        <dl className="divide-y divide-ink-800">
          <Row k="Asset ID">
            <span className="font-mono">{asset.assetId}</span>
          </Row>
          <Row k="Category">{humanize(asset.assetType)}</Row>
          <Row k="Zone">{asset.environment}</Row>
          <Row k="Criticality">{humanize(asset.criticality)}</Row>
          <Row k="Health">
            <span className="inline-flex flex-wrap gap-1">
              <HealthBadge status={asset.healthStatus} />
              {asset.impactType === 'exposed' && <ExposureBadge />}
            </span>
          </Row>
          <Row k="Operational">{humanize(asset.operationalStatus)}</Row>
          <Row k="Impact">{impact}</Row>
          <Row k="Active incidents">{activeCount}</Row>
          <Row k="Telemetry">
            <span className="rounded bg-violet-500/10 px-1.5 text-violet-300">{asset.telemetrySource}</span> <span className="text-slate-500">{asset.telemetrySource === 'physical_sensor' ? '(real measurements)' : '(simulated)'}</span>
          </Row>
          <Row k="Last update">{fmtDateTime(asset.updatedAt)}</Row>
        </dl>

        {rootIncidents.length > 0 && (
          <section className="space-y-2">
            <h3 className="panel-title">Response</h3>
            {rootIncidents.map(inc => (
              <div key={String(inc.incidentId)} className="space-y-1">
                <Link to={`/incidents/${inc.incidentId}`} className="font-mono text-xs text-cyan-300 hover:underline">
                  INC-{String(inc.incidentId)} · {inc.title.slice(0, 40)}
                </Link>
                <ResponseControls incident={inc} assetId={asset.assetId} compact />
              </div>
            ))}
          </section>
        )}

        <TelemetrySection assetId={asset.assetId} />

        <section>
          <h3 className="panel-title mb-1.5">Outgoing — requires ({requires.length})</h3>
          {requires.length === 0 && <p className="text-xs text-slate-500">No dependencies.</p>}
          <ul className="space-y-1">
            {requires.map(d => (
              <li key={String(d.dependencyId)} className="text-xs">
                {link(d.requiredAssetId)} <span className="text-slate-500">· {d.dependencyType}</span>
                <div className="text-slate-500">{d.rationale}</div>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="panel-title mb-1.5">Incoming — required by ({dependents.length})</h3>
          {dependents.length === 0 && <p className="text-xs text-slate-500">No dependents.</p>}
          <ul className="space-y-1">
            {dependents.map(d => (
              <li key={String(d.dependencyId)} className="text-xs">
                {link(d.dependentAssetId)} <span className="text-slate-500">· {d.dependencyType}</span>
              </li>
            ))}
          </ul>
        </section>
        {explanations.length > 0 && (
          <section aria-label="Why is this service affected">
            <h3 className="panel-title mb-1.5">Why is this service affected?</h3>
            <ul className="space-y-2">
              {explanations.map(x => (
                <li key={String(x.incidentId)} className="space-y-1 rounded border border-ink-700 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link to={`/incidents/${x.incidentId}`} className="font-mono text-cyan-300 hover:underline">
                      INC-{String(x.incidentId)}
                    </Link>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${x.basis === 'confirmed' ? 'bg-red-500/20 text-red-200' : 'bg-orange-500/15 text-orange-200'}`}>
                      {x.basis === 'confirmed' ? 'Confirmed root' : x.role === 'exposed' ? 'Modeled exposure' : 'Modeled impact'}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${x.source === 'measured' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-violet-500/15 text-violet-200'}`}>{x.source === 'measured' ? 'real event' : 'simulation'}</span>
                  </div>
                  {x.path.length > 1 && (
                    <div className="flex flex-wrap items-center gap-1 text-slate-300" aria-label="Attack path from root">
                      {x.path.map((id, i) => (
                        <span key={id} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-slate-500">→</span>}
                          {id === asset.assetId ? <strong className="text-slate-100">{assetById.get(id)?.name ?? id}</strong> : link(id)}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-slate-400">{x.reason}</p>
                </li>
              ))}
            </ul>
            {myEvidence.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs" aria-label="Evidence for this service">
                {myEvidence.map(e => (
                  <li key={String(e.evidenceId)} className="flex gap-1.5">
                    <span className="font-mono text-cyan-300">E{String(e.evidenceId)}</span>
                    <span className="text-slate-300">{e.title}</span>
                    <span className={e.synthetic ? 'text-violet-300' : 'text-emerald-300'}>{e.synthetic ? 'synthetic' : 'measured'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section>
          <h3 className="panel-title mb-1.5">Related incidents ({related.length})</h3>
          {related.length === 0 && <p className="text-xs text-slate-500">None.</p>}
          <ul className="space-y-1.5">
            {related.map(ia => {
              const inc = incidents.find(i => i.incidentId === ia.incidentId);
              return (
                <li key={String(ia.incidentAssetId)} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Link to={`/incidents/${ia.incidentId}`} className="font-mono text-cyan-300 hover:underline">
                    INC-{String(ia.incidentId)}
                  </Link>
                  {inc && <SeverityBadge severity={inc.severity} />}
                  {inc && <StatusBadge status={inc.status} />}
                  <span className="text-slate-500">
                    {ia.impactType === 'direct' ? 'root' : `hop ${ia.depth}`} · {ia.impactStatus} · peak {ia.peakStatus}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h3 className="panel-title mb-1.5">Recent events</h3>
          {recent.length === 0 ? (
            <p className="text-xs text-slate-500">No events for this service.</p>
          ) : (
            <ul className="space-y-1.5">
              {recent.map(e => (
                <li key={String(e.eventId)} className="text-xs">
                  <span className="font-mono text-slate-500">{fmtTime(e.timestamp)}</span> <span className="text-slate-300">{humanize(e.eventType)}</span>
                  <div className="text-slate-400">{e.description}</div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canInject && (
          <section className="space-y-2 rounded-md border border-ink-700 p-3">
            <h3 className="panel-title">Fault injection (simulation)</h3>
            {activeSims.length === 0 ? (
              <p className="text-xs text-slate-500">Requires an active simulated incident.</p>
            ) : (
              <>
                <select className="input py-1 text-xs" value={target ? String(target.incidentId) : ''} onChange={e => setInjectInto(e.target.value)} aria-label="Incident to attach the fault to">
                  {activeSims.map(i => (
                    <option key={String(i.incidentId)} value={String(i.incidentId)}>
                      INC-{String(i.incidentId)} · {i.title.slice(0, 40)}
                    </option>
                  ))}
                </select>
                <input className="input py-1 text-xs" value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for fault injection" maxLength={200} aria-label="Reason for fault injection" />
                <div className="flex gap-2">
                  {(['degraded', 'offline'] as const).map(mode => (
                    <button
                      key={mode}
                      className="btn-ghost flex-1 py-1 text-xs"
                      disabled={pending !== null || !connected || reason.trim().length < 3 || !target}
                      onClick={() =>
                        target &&
                        void run(`inject-${mode}`, c => c.reducers.updateAssetStatus({ assetId: asset.assetId, failure: mode, incidentId: target.incidentId, reason }), `Injected ${mode} fault on ${asset.name}`).then(ok => ok && setReason(''))
                      }
                    >
                      <Zap className="size-3.5" /> {mode === 'offline' ? 'Take offline' : 'Degrade'}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
