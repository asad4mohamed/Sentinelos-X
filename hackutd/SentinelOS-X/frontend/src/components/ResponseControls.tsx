// Containment + recovery controls for one root asset of one incident.
// Every button calls a real reducer; permissions and gating are enforced by
// the server — the UI only explains them.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ShieldCheck, Wrench } from 'lucide-react';
import { useSentinel } from '../hooks/useSentinelData';
import { useAction } from '../hooks/useAction';
import { CAN, type Incident, type Role } from '../types/domain';
import { CONTAINMENT, scenarioByType, type EffectKind } from '../lib/engine';
import { StatusBadge } from './StatusBadge';
import { humanize } from '../lib/format';

const PHASE_LABEL: Record<string, string> = { active: 'Active', contained: 'Contained', recovering: 'Recovering', cleared: 'Cleared' };
const PHASE_TONE: Record<string, string> = { active: 'text-red-300', contained: 'text-cyan-300', recovering: 'text-sky-300', cleared: 'text-emerald-300' };

export function ResponseControls({ incident, assetId, compact = false }: { incident: Incident; assetId: string; compact?: boolean }) {
  const { effects, recoveries, assetById, me, responderByHex, myHex } = useSentinel();
  const { run, pending, connected } = useAction();
  const scen = scenarioByType(incident.scenarioType);
  const [plan, setPlan] = useState(scen?.recoveryPlan ?? 'Restore service from last known-good state (simulated)');
  const asset = assetById.get(assetId);
  const mine = effects.filter(e => e.incidentId === incident.incidentId && e.assetId === assetId).sort((a, b) => (a.effectId < b.effectId ? -1 : 1));
  const live = mine.filter(e => e.phase !== 'cleared');
  const role = me?.role as Role | undefined;
  const can = (k: keyof typeof CAN) => !!role && CAN[k].includes(role);
  const open = incident.status !== 'resolved';
  const containable = live.filter(e => e.phase === 'active' && CONTAINMENT[e.kind as EffectKind]);
  const needsContainment = containable.length > 0;
  const unrecovered = live.filter(e => e.phase === 'active' || e.phase === 'contained');
  const pendingRec = recoveries.find(r => r.incidentId === incident.incidentId && r.assetId === assetId && r.status === 'pending');
  const lastRec = [...recoveries].filter(r => r.incidentId === incident.incidentId && r.assetId === assetId).sort((a, b) => (a.recoveryId < b.recoveryId ? 1 : -1))[0];
  const disabled = pending !== null || !connected;

  if (mine.length === 0) return null;
  const contain = CONTAINMENT[(containable[0]?.kind ?? '') as EffectKind];

  return (
    <div className={`space-y-2 rounded-md border border-ink-700 ${compact ? 'p-2.5' : 'p-3'}`} aria-label={`Response controls for ${asset?.name ?? assetId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-200">{asset?.name ?? assetId}</span>
        <span className="flex flex-wrap gap-2">
          {mine.map(e => (
            <span key={String(e.effectId)} className={PHASE_TONE[e.phase] ?? 'text-slate-300'}>
              {humanize(e.kind)}: {PHASE_LABEL[e.phase] ?? e.phase}
            </span>
          ))}
        </span>
      </div>

      {open && unrecovered.length > 0 && (
        <ol className="space-y-2 text-xs">
          <li className="flex items-start gap-2">
            <span className={`mt-0.5 rounded-full px-1.5 font-mono ${needsContainment ? 'bg-amber-500/20 text-amber-200' : 'bg-emerald-500/20 text-emerald-200'}`}>1</span>
            <div className="flex-1">
              {needsContainment && contain ? (
                <>
                  <div className="text-slate-300">Contain: {contain.label} (simulated)</div>
                  {can('contain') ? (
                    <button
                      className="btn-ghost mt-1 py-1 text-xs"
                      disabled={disabled}
                      onClick={() => void run(`contain-${assetId}`, c => c.reducers.applyContainment({ incidentId: incident.incidentId, assetId }), `${asset?.name ?? assetId} contained`)}
                    >
                      <ShieldCheck className="size-3.5" /> Apply containment
                    </button>
                  ) : (
                    <p className="text-slate-500">Register as a responder to use this control.</p>
                  )}
                </>
              ) : (
                <div className="text-slate-400">{live.some(e => e.phase === 'contained') ? 'Contained.' : 'No containment step for this effect.'}</div>
              )}
            </div>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 rounded-full bg-ink-700 px-1.5 font-mono text-slate-300">2</span>
            <div className="flex-1 space-y-1">
              <div className="text-slate-300">Recover (two-person approval)</div>
              {pendingRec ? (
                <p className="text-amber-300">
                  Recovery #{String(pendingRec.recoveryId)} requested by {responderByHex.get(pendingRec.requestedBy.toHexString())?.displayName ?? 'unknown'} —{' '}
                  {pendingRec.requestedBy.toHexString() === myHex ? 'awaiting a different responder.' : can('decideRecovery') ? (
                    <Link to={`/command/${incident.incidentId}`} className="text-cyan-300 hover:underline">
                      approve in Incident Command
                    </Link>
                  ) : (
                    'awaiting an Incident Commander.'
                  )}
                </p>
              ) : needsContainment ? (
                <p className="text-slate-500">Available after containment.</p>
              ) : can('requestRecovery') ? (
                <>
                  <input className="input py-1 text-xs" value={plan} onChange={e => setPlan(e.target.value)} maxLength={500} aria-label="Recovery plan" />
                  <button
                    className="btn-primary py-1 text-xs"
                    disabled={disabled || plan.trim().length < 5}
                    onClick={() => void run(`recover-${assetId}`, c => c.reducers.requestRecovery({ incidentId: incident.incidentId, assetId, plan }), 'Recovery requested — a second Incident Commander must approve')}
                  >
                    <Wrench className="size-3.5" /> Request recovery
                  </button>
                </>
              ) : (
                <p className="text-slate-500">Register as a responder to use this control.</p>
              )}
            </div>
          </li>
        </ol>
      )}
      {live.some(e => e.phase === 'recovering') && <p className="text-xs text-sky-300">Simulated restoration in progress — returns to healthy within a few engine ticks.</p>}
      {live.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-300">
          <CheckCircle2 className="size-3.5" /> Recovered{lastRec ? <> · recovery #{String(lastRec.recoveryId)} <StatusBadge status={lastRec.status} /></> : null}
        </p>
      )}
    </div>
  );
}
