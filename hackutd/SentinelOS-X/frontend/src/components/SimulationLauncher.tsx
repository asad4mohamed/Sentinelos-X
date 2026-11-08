import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, FlaskConical, ShieldAlert, Target } from 'lucide-react';
import { useSentinel } from '../hooks/useSentinelData';
import { useAction } from '../hooks/useAction';
import { CAN, type Role } from '../types/domain';
import { SCENARIOS, computeBlastRadius, type DependencyType, type EffectKind } from '../lib/engine';
import { Modal } from './ui';
import { HealthBadge } from './StatusBadge';

/** Expected impact of launching a scenario now, computed in-browser with the module's engine. */
export function useScenarioPreview(scenarioType: string) {
  const { assets, dependencies } = useSentinel();
  return useMemo(() => {
    const scen = SCENARIOS.find(s => s.scenarioType === scenarioType);
    if (!scen) return null;
    const edges = dependencies.map(d => ({ dependentAssetId: d.dependentAssetId, requiredAssetId: d.requiredAssetId, dependencyType: d.dependencyType as DependencyType }));
    const r = computeBlastRadius(assets.map(a => a.assetId), edges, [{ assetId: scen.initialAssetId, kind: scen.effectKind as EffectKind, level: scen.effectLevel, phase: 'active', intensity: 0.4 }]);
    const hit = [...r.values()].filter(b => b.role !== 'none');
    return {
      affected: hit.length,
      direct: hit.filter(b => b.role === 'dependent' && b.level !== 'healthy' && b.depth === 1).length,
      indirect: hit.filter(b => b.role === 'dependent' && b.level !== 'healthy' && b.depth >= 2).length,
      exposed: hit.filter(b => b.role === 'dependent' && b.level === 'healthy' && b.exposed).length,
      names: hit.filter(b => b.role === 'dependent').map(b => assets.find(a => a.assetId === b.assetId)?.name ?? b.assetId),
    };
  }, [assets, dependencies, scenarioType]);
}

function Preview({ scenarioType }: { scenarioType: string }) {
  const p = useScenarioPreview(scenarioType);
  if (!p) return null;
  return (
    <div className="mt-2 rounded border border-ink-700 bg-ink-950 p-2 text-[11px]">
      <div className="text-slate-400">
        Expected impact: <span className="text-slate-100">{p.affected}</span> services — {p.direct} direct, {p.indirect} indirect, {p.exposed} potentially exposed
      </div>
      {p.names.length > 0 && <div className="mt-0.5 text-slate-500">{p.names.join(', ')}</div>}
      <div className="mt-1 text-slate-600">Preview only. SpacetimeDB computes the authoritative result when the scenario launches.</div>
    </div>
  );
}

export function SimulationLauncher({ compact = false }: { compact?: boolean }) {
  const { me, incidents, assetById, assets } = useSentinel();
  const { run, pending, connected } = useAction();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(SCENARIOS[0]!.scenarioType);
  const [launchedAt, setLaunchedAt] = useState<{ type: string; at: number } | null>(null);

  const allowed = me ? CAN.launchSimulation.includes(me.role as Role) : false;
  const busy = pending === 'launch';
  const activeOf = (type: string) => incidents.find(i => i.scenarioType === type && i.status !== 'resolved');
  const launched = launchedAt ? incidents.filter(i => i.scenarioType === launchedAt.type && i.createdAt.toDate().getTime() >= launchedAt.at - 60_000).sort((a, b) => (a.incidentId < b.incidentId ? 1 : -1))[0] : undefined;

  let reason = '';
  if (!connected) reason = 'Disconnected from SpacetimeDB — actions unavailable';
  else if (!me) reason = 'Register as a responder first';
  else if (!allowed) reason = 'Requires Incident Commander or Security Analyst';
  else if (assets.length === 0) reason = 'No virtual infrastructure loaded';

  const scen = SCENARIOS.find(s => s.scenarioType === choice)!;
  const target = assetById.get(scen.initialAssetId);
  const activeChoice = activeOf(choice);

  const launch = async () => {
    const at = Date.now();
    const ok = await run('launch', c => c.reducers.launchSimulatedIncident({ scenarioType: choice, title: '' }), `${scen.label} launched — confirmed by SpacetimeDB`);
    if (ok) setLaunchedAt({ type: choice, at });
  };

  return (
    <>
      <div className={compact ? '' : 'flex flex-col items-end gap-1'}>
        <button className="btn-danger" onClick={() => { setLaunchedAt(null); setOpen(true); }} disabled={!!reason} aria-describedby={reason ? 'sim-launch-reason' : undefined}>
          <FlaskConical className="size-4" aria-hidden />
          Launch Simulated Incident
        </button>
        {!compact && reason && (
          <span id="sim-launch-reason" className="text-xs text-slate-500">
            {reason}
          </span>
        )}
      </div>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Launch a synthetic incident scenario"
        wide
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
              {launched ? 'Close' : 'Cancel'}
            </button>
            {launched ? (
              <Link className="btn-primary" to={`/incidents/${launched.incidentId}`} onClick={() => setOpen(false)}>
                Open INC-{String(launched.incidentId)}
              </Link>
            ) : (
              <button className="btn-danger" onClick={launch} disabled={busy || !!activeChoice || !!reason}>
                {busy ? 'Waiting for SpacetimeDB…' : 'Start simulation'}
              </button>
            )}
          </>
        }
      >
        <div className="flex gap-3 rounded-md border border-violet-500/30 bg-violet-950/30 p-3 text-violet-100">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <p className="text-xs text-violet-200/90">
            Defensive training on <strong>synthetic</strong> infrastructure only. No real systems, traffic, accounts or files are touched. Impact is computed server-side by the deterministic dependency engine.
          </p>
        </div>
        {launched ? (
          <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-950/30 p-3 text-sm text-emerald-100" role="status">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
            <div>
              INC-{String(launched.incidentId)} created: {launched.title}. Every connected browser now shows the incident and the affected services.
            </div>
          </div>
        ) : (
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Scenario</legend>
            {SCENARIOS.map(s => {
              const a = assetById.get(s.initialAssetId);
              const act = activeOf(s.scenarioType);
              const checked = choice === s.scenarioType;
              return (
                <label key={s.scenarioType} className={`cursor-pointer rounded-md border p-3 text-xs ${checked ? 'border-cyan-400 bg-cyan-500/5' : 'border-ink-700 hover:border-ink-600'}`}>
                  <input type="radio" name="scenario" className="sr-only" value={s.scenarioType} checked={checked} onChange={() => setChoice(s.scenarioType)} />
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-100">{s.label}</span>
                    {act && <span className="shrink-0 rounded bg-amber-500/20 px-1.5 text-[10px] text-amber-200">Active · INC-{String(act.incidentId)}</span>}
                  </div>
                  <p className="mt-1 text-slate-400">{s.description.replace(/^SIMULATION:\s*/, '')}</p>
                  <div className="mt-2 flex items-center gap-1.5 text-slate-300">
                    <Target className="size-3.5 text-red-300" aria-hidden /> Initial target: <span className="font-medium">{a?.name ?? s.initialAssetId}</span>
                    {a && <HealthBadge status={a.healthStatus} />}
                  </div>
                  {checked && <Preview scenarioType={s.scenarioType} />}
                </label>
              );
            })}
          </fieldset>
        )}
        {!launched && activeChoice && (
          <p className="text-xs text-amber-300">
            This scenario is already active as{' '}
            <Link to={`/incidents/${activeChoice.incidentId}`} className="underline" onClick={() => setOpen(false)}>
              INC-{String(activeChoice.incidentId)}
            </Link>
            . Recover and resolve it, or choose a different scenario (overlapping scenarios are supported).
          </p>
        )}
        {!launched && target && <span className="sr-only">Selected target {target.name}</span>}
      </Modal>
    </>
  );
}
