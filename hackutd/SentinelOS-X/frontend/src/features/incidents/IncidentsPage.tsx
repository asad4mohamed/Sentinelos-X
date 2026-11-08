import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileSearch, Filter, Radio, Search, ShieldCheck, Siren, FlaskConical } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { EMPTY_INCIDENT_FILTER, chronological, filterIncidents, type IncidentFilter, type IncidentSort } from '../../lib/derive';
import { deriveBlast } from '../../lib/blast';
import { scenarioByType } from '../../lib/engine';
import { EmptyState, Panel } from '../../components/ui';
import { PageGate } from '../../components/PageGate';
import { RealBadge, SeverityBadge, SimBadge, StatusBadge } from '../../components/StatusBadge';
import { Timeline } from '../../components/Timeline';
import { SimulationLauncher } from '../../components/SimulationLauncher';
import { ResponseControls } from '../../components/ResponseControls';
import { BlastRadiusPanel } from './BlastRadiusPanel';
import { ExportReport } from '../../components/ExportReport';
import { CAN, INCIDENT_NEXT, INCIDENT_STATUS_LABEL, type Incident, type IncidentStatus, type Role } from '../../types/domain';
import { fmtDateTime, fmtTime, humanize, relTime } from '../../lib/format';

const SEV_TONE: Record<string, string> = { info: 'text-sky-300', low: 'text-sky-300', medium: 'text-amber-300', high: 'text-red-300', critical: 'text-red-400' };

export function scenarioLabel(type: string) {
  return scenarioByType(type)?.label ?? humanize(type);
}

export function IncidentsPage() {
  return (
    <PageGate>
      <IncidentsView />
    </PageGate>
  );
}

function IncidentsView() {
  const { incidents, incidentAssets, assets, assetById } = useSentinel();
  const { incidentId } = useParams();
  const navigate = useNavigate();
  const [f, setF] = useState<IncidentFilter>(EMPTY_INCIDENT_FILTER);

  const affected = useMemo(() => {
    const m = new Map<bigint, Set<string>>();
    for (const ia of incidentAssets) {
      const s = m.get(ia.incidentId) ?? new Set<string>();
      s.add(ia.assetId);
      m.set(ia.incidentId, s);
    }
    return m;
  }, [incidentAssets]);
  const impactedNow = useMemo(() => {
    const m = new Map<bigint, number>();
    for (const ia of incidentAssets) if (ia.impactStatus !== 'recovered') m.set(ia.incidentId, (m.get(ia.incidentId) ?? 0) + 1);
    return m;
  }, [incidentAssets]);
  const list = useMemo(() => filterIncidents(incidents, affected, f), [incidents, affected, f]);
  const selected = incidentId ? incidents.find(i => String(i.incidentId) === incidentId) : list[0];
  const dirty = JSON.stringify({ ...f }) !== JSON.stringify(EMPTY_INCIDENT_FILTER);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-50">Incidents</h1>
          <p className="text-sm text-slate-400">
            {incidents.length} total · {incidents.filter(i => i.status !== 'resolved').length} active · updates live from SpacetimeDB
          </p>
        </div>
        <SimulationLauncher compact />
      </div>

      <div className="panel flex flex-wrap items-end gap-3 p-3" role="search" aria-label="Filter incidents">
        <Filter className="mb-2 size-4 text-slate-500" aria-hidden />
        <label className="relative min-w-52 flex-1">
          <span className="mb-1 block text-xs text-slate-400">Search</span>
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-4 text-slate-500" aria-hidden />
          <input className="input pl-8" value={f.query} onChange={e => setF({ ...f, query: e.target.value })} placeholder="Title or INC-id" />
        </label>
        <Select label="Status" value={f.status} onChange={status => setF({ ...f, status })} options={['', 'active', 'open', 'investigating', 'contained', 'recovering', 'resolved']} labels={{ active: 'Active', ...INCIDENT_STATUS_LABEL }} />
        <Select label="Severity" value={f.severity} onChange={severity => setF({ ...f, severity })} options={['', 'low', 'medium', 'high', 'critical']} />
        <Select label="Service" value={f.assetId} onChange={assetId => setF({ ...f, assetId })} options={['', ...assets.map(a => a.assetId).sort()]} labels={Object.fromEntries(assets.map(a => [a.assetId, a.name]))} />
        <Select label="Activity" value={String(f.recentMinutes)} onChange={v => setF({ ...f, recentMinutes: Number(v) })} options={['0', '15', '60', '1440']} labels={{ '0': 'Any time', '15': 'Last 15 min', '60': 'Last hour', '1440': 'Last 24 h' }} />
        <Select label="Sort" value={f.sort} onChange={sort => setF({ ...f, sort: sort as IncidentSort })} options={['newest', 'oldest', 'severity', 'updated']} labels={{ newest: 'Newest first', oldest: 'Oldest first', severity: 'Severity', updated: 'Recently updated' }} />
        {dirty && (
          <button className="btn-ghost mb-0.5" onClick={() => setF(EMPTY_INCIDENT_FILTER)}>
            Clear
          </button>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[27rem_1fr]">
        <Panel title={`Incident list (${list.length})`} bodyClass="p-0" className="xl:self-start">
          {list.length === 0 ? (
            <EmptyState icon={Siren} title={incidents.length ? 'No incidents match these filters' : 'No active incidents. Launch a synthetic scenario to test the environment.'} />
          ) : (
            <ul className="max-h-[72vh] divide-y divide-ink-800 overflow-y-auto">
              {list.map(i => (
                <li key={String(i.incidentId)}>
                  <button
                    onClick={() => navigate(`/incidents/${i.incidentId}`)}
                    className={`w-full px-4 py-3 text-left hover:bg-ink-800 ${selected?.incidentId === i.incidentId ? 'bg-ink-800' : ''}`}
                    aria-current={selected?.incidentId === i.incidentId}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs text-slate-500">INC-{String(i.incidentId)}</span>
                      <SeverityBadge severity={i.severity} />
                      <StatusBadge status={i.status} />
                    </div>
                    <div className="mt-1 truncate text-sm text-slate-100">{i.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {scenarioLabel(i.scenarioType)} · initial {assetById.get(i.initialAssetId)?.name ?? i.initialAssetId}
                    </div>
                    <div className="text-xs text-slate-500">
                      {impactedNow.get(i.incidentId) ?? 0} impacted now · created {fmtDateTime(i.createdAt)} · updated {relTime(i.updatedAt)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {selected ? (
          <IncidentDetail incident={selected} />
        ) : incidentId ? (
          <Panel>
            <EmptyState title={`Incident ${incidentId} not found`} />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options, labels }: { label: string; value: string; onChange: (v: string) => void; options: string[]; labels?: Record<string, string> }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      {label}
      <select className="input w-36 py-1.5" value={value} onChange={e => onChange(e.target.value)} aria-label={label}>
        {options.map(o => (
          <option key={o} value={o}>
            {labels?.[o] ?? (o === '' ? 'All' : humanize(o))}
          </option>
        ))}
      </select>
    </label>
  );
}

function EvidencePanel({ incident }: { incident: Incident }) {
  const { evidence, assetById } = useSentinel();
  const rows = useMemo(() => [...evidence].filter(e => e.incidentId === incident.incidentId).sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1)), [evidence, incident.incidentId]);
  const measured = rows.filter(e => !e.synthetic).length;
  const origin = measured === 0 ? 'synthetic' : measured === rows.length ? 'measured · real hardware' : 'mixed: measured and synthetic';
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <FileSearch className="size-3.5" /> Evidence ({rows.length}){' '}
          <span className={`normal-case tracking-normal ${measured === 0 ? 'text-violet-300' : 'text-emerald-300'}`}>· {origin}</span>
        </span>
      }
      bodyClass="max-h-[50vh] overflow-y-auto p-0"
    >
      {rows.length === 0 ? (
        <EmptyState title="No evidence recorded" />
      ) : (
        <ul className="divide-y divide-ink-800" aria-label={measured === 0 ? 'Synthetic evidence' : 'Evidence'}>
          {rows.map(e => (
            <li key={String(e.evidenceId)} className="space-y-1 px-4 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`font-semibold uppercase ${SEV_TONE[e.severity] ?? 'text-slate-300'}`}>{e.severity}</span>
                <span className="font-medium text-slate-100">{e.title}</span>
                <span className="ml-auto font-mono text-slate-500">{fmtTime(e.observedAt)}</span>
              </div>
              <p className="text-slate-400">{e.detail}</p>
              <div className="flex flex-wrap gap-1">
                <span className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-300">{e.kind}</span>
                {!e.synthetic && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">measured</span>}
                <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">{assetById.get(e.assetId)?.name ?? e.assetId}</span>
                {e.indicators.map(ind => (
                  <span key={ind.key} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                    {ind.key}={ind.value}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function IncidentDetail({ incident }: { incident: Incident }) {
  const { incidentAssets, events, assetById, me, effects, dependencies } = useSentinel();
  const { run, pending } = useAction();
  const blast = useMemo(() => deriveBlast(incident.incidentId, incidentAssets, effects, dependencies, assetById, true), [incident.incidentId, incidentAssets, effects, dependencies, assetById]);
  const timeline = useMemo(() => chronological(events.filter(e => e.incidentId === incident.incidentId)), [events, incident.incidentId]);
  const canUpdate = me ? CAN.updateIncidentStatus.includes(me.role as Role) : false;
  const next = INCIDENT_NEXT[incident.status as IncidentStatus] ?? [];
  const roots = [...new Set(effects.filter(e => e.incidentId === incident.incidentId).map(e => e.assetId))].sort();

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-slate-500">INC-{String(incident.incidentId)}</span>
              <SeverityBadge severity={incident.severity} />
              <StatusBadge status={incident.status} />
              {incident.isSimulation ? <SimBadge /> : <RealBadge />}
            </div>
            <h2 className="text-lg font-semibold text-slate-50">{incident.title}</h2>
            <p className="max-w-3xl text-sm text-slate-400">{incident.description}</p>
            <p className="text-xs text-slate-500">
              {scenarioLabel(incident.scenarioType)} · initial target {assetById.get(incident.initialAssetId)?.name ?? incident.initialAssetId} · started {fmtDateTime(incident.createdAt)} · updated {relTime(incident.updatedAt)}
              {incident.resolvedAt && ` · resolved ${fmtDateTime(incident.resolvedAt)}`}
            </p>
            {incident.resolutionSummary && <p className="text-sm text-emerald-300">Resolution: {incident.resolutionSummary}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {canUpdate &&
              next.map(s => (
                <button key={s} className="btn-ghost" disabled={pending !== null} onClick={() => void run(`status-${s}`, c => c.reducers.updateIncidentStatus({ incidentId: incident.incidentId, status: s }), `Status set to ${INCIDENT_STATUS_LABEL[s] ?? s}`)}>
                  Mark {INCIDENT_STATUS_LABEL[s] ?? humanize(s)}
                </button>
              ))}
            <ExportReport incidentId={incident.incidentId} />
            {incident.status !== 'resolved' && (
              <Link className="btn-ghost" to={`/lab/${incident.incidentId}`}>
                <FlaskConical className="size-4" /> Compare responses
              </Link>
            )}
            <Link className="btn-primary" to={`/command/${incident.incidentId}`}>
              <Radio className="size-4" /> Command room
            </Link>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 2xl:grid-cols-2">
        <BlastRadiusPanel incident={incident} summary={blast} />
        <div className="space-y-4">
          <Panel title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> Containment &amp; recovery (simulated)</span>}>
            {roots.length === 0 ? (
              <p className="text-xs text-slate-500">No root-cause effects recorded for this incident.</p>
            ) : (
              <div className="space-y-2">
                {roots.map(id => (
                  <ResponseControls key={id} incident={incident} assetId={id} />
                ))}
                <p className="text-[11px] text-slate-500">Workflow: contain (where applicable) → request recovery → a different Incident Commander approves → the engine restores the service (Recovering → Healthy).</p>
              </div>
            )}
          </Panel>
          <EvidencePanel incident={incident} />
        </div>
      </div>
      <Panel title={`Timeline (${timeline.length} events)`} bodyClass="max-h-[60vh] overflow-y-auto p-4">
        {timeline.length ? <Timeline events={timeline} assetById={assetById} /> : <EmptyState title="No events" />}
      </Panel>
    </div>
  );
}
