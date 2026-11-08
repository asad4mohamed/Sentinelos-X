// Response Decision Lab: compare possible responses to an incident BEFORE acting.
//
// - The comparison is computed by the deterministic engine (spacetime/src/decisionLab.ts)
//   from subscribed, authoritative rows. It is a preview: nothing here changes state.
// - "Propose this response" calls propose_response; the server recomputes the same
//   engine and rejects the proposal if the incident changed since this preview.
// - Adopting a proposal executes nothing. Steps still use the existing containment
//   and two-person recovery controls.
// - "Explain with Nemotron" asks the authorized agent to explain the ENGINE's results;
//   it may only cite this incident's evidence (checked server-side).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, FlaskConical, Info, Loader2, Scale, ShieldCheck, Users, XCircle } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { PageGate } from '../../components/PageGate';
import { EmptyState, ErrorBanner, Panel } from '../../components/ui';
import { RealBadge, SeverityBadge, SimBadge, StatusBadge } from '../../components/StatusBadge';
import { ResponseControls } from '../../components/ResponseControls';
import { buildLabInput, splitCitations } from '../../lib/decisionLab';
import { evaluateAll, recommend, rootTargets, STRATEGY_NAME, type LabReport, type StrategyId, type StrategyResult } from '../../lib/engine';
import { fmtTime, relTime } from '../../lib/format';
import { CAN, type Incident, type Role } from '../../types/domain';
import { ImpactGraph, StateLegend } from './ImpactGraph';

const STRATEGY_BLURB: Record<StrategyId, string> = {
  isolate: 'Cut the service off to stop the problem spreading. Usually makes dependents worse in the short term.',
  restore: 'Bring the service back through the approved recovery workflow (needs a second responder).',
  failover: 'Switch to a standby copy. The twin has no standby, so this is modeled only.',
  staged: 'Contain first, then recover — the safest order when a containment action exists.',
};

function Term({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <abbr title={tip} className="cursor-help underline decoration-slate-600 decoration-dotted underline-offset-2">
      {children}
    </abbr>
  );
}

function SupportBadge({ support }: { support: StrategyResult['support'] }) {
  return support === 'executable' ? (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-200">
      <CheckCircle2 className="size-3" aria-hidden /> Executable here
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-200" title="Includes at least one step that SentinelOS X cannot perform; its effect is modeled only">
      <CircleDashed className="size-3" aria-hidden /> Hypothetical (modeled)
    </span>
  );
}

function List({ title, items, icon: Icon, tone = 'text-slate-300', empty = 'None' }: { title: string; items: string[]; icon?: typeof Info; tone?: string; empty?: string }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{title}</h4>
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">{empty}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {items.map((t, i) => (
            <li key={i} className={`flex gap-1.5 ${tone}`}>
              {Icon && <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
              <span>{t}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StrategyCard({ r, selected, onSelect, nameOf, picked }: { r: StrategyResult; selected: boolean; onSelect: () => void; nameOf: (id: string) => string; picked: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`panel flex h-full flex-col gap-2 p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-cyan-400 ${selected ? 'border-cyan-500/70 bg-cyan-500/5' : 'hover:border-ink-600'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-slate-100">{r.name}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        <SupportBadge support={r.support} />
        {picked && <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[11px] font-medium text-cyan-200">★ Engine pick</span>}
      </div>
      <p className="text-xs text-slate-400">{STRATEGY_BLURB[r.strategy]}</p>
      <dl className="mt-auto grid grid-cols-3 gap-1 text-center text-[11px]">
        <div className="rounded bg-ink-800 px-1 py-1.5">
          <dt className="text-slate-400">Restored</dt>
          <dd className="text-base font-semibold text-emerald-300 tabular-nums">{r.restored.length}</dd>
        </div>
        <div className="rounded bg-ink-800 px-1 py-1.5">
          <dt className="text-slate-400">Made worse</dt>
          <dd className={`text-base font-semibold tabular-nums ${r.disrupted.length ? 'text-red-300' : 'text-slate-300'}`}>{r.disrupted.length}</dd>
        </div>
        <div className="rounded bg-ink-800 px-1 py-1.5">
          <dt className="text-slate-400">Still affected</dt>
          <dd className="text-base font-semibold text-amber-200 tabular-nums">{r.stillAffected.length}</dd>
        </div>
      </dl>
      <div className="text-[11px] text-slate-400">
        Modeled severity: <span className="text-slate-200">{r.before.severity}</span> → <span className="text-slate-200">{r.after.severity}</span>
        {r.steps.some(s => s.approval === 'two_person') && (
          <span className="ml-2 inline-flex items-center gap-1 text-amber-200">
            <Users className="size-3" aria-hidden /> 2-person
          </span>
        )}
      </div>
      {r.disrupted.length > 0 && <div className="text-[11px] text-red-300">Worse: {r.disrupted.map(nameOf).join(', ')}</div>}
    </button>
  );
}

function StrategyDetail({ r, nameOf }: { r: StrategyResult; nameOf: (id: string) => string }) {
  const { assets, dependencies } = useSentinel();
  const [stage, setStage] = useState(r.stages.length - 1);
  useEffect(() => setStage(r.stages.length - 1), [r]);
  const shown = r.stages[Math.min(stage, r.stages.length - 1)]!;
  const names = (ids: string[]) => ids.map(nameOf);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StateLegend />
        {r.stages.length > 1 && (
          <div role="tablist" aria-label="Response stage" className="flex flex-wrap gap-1">
            {r.stages.map((s, i) => (
              <button key={s.label} role="tab" aria-selected={i === stage} className={`rounded px-2 py-1 text-xs ${i === stage ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-400 hover:bg-ink-800'}`} onClick={() => setStage(i)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <ImpactGraph title="Now (authoritative state)" assets={assets} dependencies={dependencies} snapshot={r.before} />
        <ImpactGraph title={`Predicted: ${shown.label}`} assets={assets} dependencies={dependencies} snapshot={shown.impact} compareTo={r.before} />
      </div>

      <div>
        <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Proposed steps</h4>
        <ol className="space-y-1.5 text-xs">
          {r.steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-ink-800 px-1.5 font-mono text-slate-300">{i + 1}</span>
              <span className="text-slate-200">{s.label}</span>
              {!s.executable && <span className="rounded bg-violet-500/15 px-1.5 text-[11px] text-violet-200">modeled only — not executable</span>}
              {s.approval === 'two_person' && <span className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-200">needs a second responder</span>}
              {s.executable && s.operation !== 'no_op' && <code className="text-[11px] text-slate-500">{s.operation}</code>}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <List title="Potentially restored" items={names(r.restored)} tone="text-emerald-200" />
        <List title="Potentially disrupted (made worse)" items={names(r.disrupted)} tone="text-red-200" />
        <List title="Still affected afterwards" items={r.stillAffected.map(id => `${nameOf(id)} — ${shown.impact.assets[id]?.state ?? r.after.assets[id]?.state}`)} tone="text-amber-100" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Preconditions</h4>
          <ul className="space-y-1 text-xs">
            {r.preconditions.map((p, i) => (
              <li key={i} className={`flex gap-1.5 ${p.met ? 'text-emerald-200' : 'text-red-200'}`}>
                {p.met ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-label="met" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" aria-label="not met" />}
                {p.text}
              </li>
            ))}
          </ul>
        </div>
        <List title="Approval requirements" items={r.approvals} icon={ShieldCheck} empty="No approval step: any registered responder may perform it." />
        <List title="Residual risks" items={r.residualRisks} icon={AlertTriangle} tone="text-amber-100" />
        <List title="Unsupported operations" items={r.unsupported} icon={CircleDashed} tone="text-violet-200" empty="None — every step maps to an existing backend operation." />
        {r.warnings.length > 0 && <List title="Warnings" items={r.warnings} icon={AlertTriangle} tone="text-amber-200" />}
        <List title="Model assumptions" items={r.assumptions} icon={Info} tone="text-slate-400" />
      </div>
    </div>
  );
}

function ExplanationPanel({ incident, targetAssetId, fingerprint }: { incident: Incident; targetAssetId: string; fingerprint: string }) {
  const { explanations, evidence, services, me } = useSentinel();
  const { run, pending, connected } = useAction();
  const role = me?.role as Role | undefined;
  const mine = explanations.filter(x => x.incidentId === incident.incidentId).sort((a, b) => (a.explanationId < b.explanationId ? 1 : -1));
  const latest = mine[0];
  const agent = services.find(s => s.kind === 'ai_agent' && s.status !== 'revoked');
  const agentReady = !!agent && agent.status === 'authorized' && agent.online;
  const active = latest && (latest.status === 'requested' || latest.status === 'running');
  const evidenceById = new Map(evidence.filter(e => e.incidentId === incident.incidentId).map(e => [String(e.evidenceId), e]));

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4 text-cyan-300" aria-hidden /> Explain with Nemotron
        </span>
      }
    >
      <div className="space-y-3 text-sm">
        {!agentReady && (
          <div role="status" className="rounded-md border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
            Nemotron agent is {agent ? (agent.status === 'pending' ? 'awaiting authorization (Settings → Services)' : 'offline') : 'not connected'}. The deterministic comparison above is complete and does not depend on AI. A request will wait until an authorized agent comes online.
          </div>
        )}
        <p className="text-xs text-slate-400">The agent receives the engine's structured results and this incident's evidence. It explains trade-offs; it cannot change the numbers, and every citation is checked against this incident's evidence by the server.</p>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary"
            disabled={!connected || pending !== null || !!active || !role || !CAN.requestRecovery.includes(role)}
            onClick={() => void run('explain', c => c.reducers.requestDecisionExplanation({ incidentId: incident.incidentId, targetAssetId }), 'Explanation requested')}
          >
            {pending === 'explain' ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />} Explain with Nemotron
          </button>
          {active && (
            <button className="btn-ghost" disabled={pending !== null} onClick={() => void run('cancel-explain', c => c.reducers.cancelDecisionExplanation({ explanationId: latest.explanationId }), 'Explanation cancelled')}>
              Cancel request
            </button>
          )}
        </div>
        {latest && (
          <div className="space-y-2 rounded-md border border-ink-700 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <StatusBadge status={latest.status} /> #{String(latest.explanationId)} · requested {relTime(latest.requestedAt)}
              {latest.model && <span>· model {latest.model}</span>}
              {latest.stateFingerprint !== fingerprint && latest.status === 'completed' && <span className="text-amber-200">· incident has changed since this explanation</span>}
              {latest.targetAssetId !== targetAssetId && <span className="text-amber-200">· explains a different root service ({latest.targetAssetId})</span>}
            </div>
            {latest.status === 'requested' && <p className="text-xs text-slate-400">Waiting for the Nemotron agent to claim this request…</p>}
            {latest.status === 'running' && (
              <p className="inline-flex items-center gap-2 text-xs text-cyan-200">
                <Loader2 className="size-3.5 animate-spin" /> Nemotron is writing the explanation…
              </p>
            )}
            {latest.status === 'failed' && <ErrorBanner title="Explanation failed" detail={latest.error ?? 'Unknown error'} />}
            {latest.status === 'completed' && latest.text && (
              <>
                <p className="text-[11px] tracking-wider text-cyan-300 uppercase">AI-generated explanation · not an authoritative result</p>
                <div className="space-y-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-200">
                  {splitCitations(latest.text).map((part, i) =>
                    part.kind === 'text' ? (
                      <span key={i}>{part.value}</span>
                    ) : (
                      <span key={i} className="mx-0.5 rounded bg-cyan-500/15 px-1 font-mono text-[11px] text-cyan-200" title={evidenceById.get(part.id)?.title ?? 'Unknown evidence id'}>
                        E{part.id}
                      </span>
                    )
                  )}
                </div>
                {latest.citedEvidence.length > 0 && (
                  <ul className="space-y-0.5 border-t border-ink-700 pt-2 text-xs text-slate-400">
                    {latest.citedEvidence.map(id => {
                      const e = evidenceById.get(String(id));
                      return (
                        <li key={String(id)}>
                          <span className="font-mono text-cyan-300">E{String(id)}</span> {e ? `${e.title} (${e.synthetic ? 'synthetic' : 'measured'})` : 'evidence no longer available'}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function ProposalsPanel({ incident, report, selected }: { incident: Incident; report: LabReport; selected: StrategyResult }) {
  const { proposals, me, myHex, assetById } = useSentinel();
  const { run, pending, connected } = useAction();
  const [rationale, setRationale] = useState('');
  const [note, setNote] = useState('');
  const role = me?.role as Role | undefined;
  const canPropose = !!role && CAN.proposeResponse.includes(role);
  const canDecide = !!role && CAN.decideResponse.includes(role);
  const list = proposals.filter(p => p.incidentId === incident.incidentId).sort((a, b) => (a.proposalId < b.proposalId ? 1 : -1));
  const blocked = selected.preconditions.filter(p => !p.met);
  const adopted = list.find(p => p.status === 'adopted');

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Scale className="size-4 text-cyan-300" aria-hidden /> Propose & review
        </span>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            Proposing records <span className="text-slate-200">{selected.name}</span> for team review. It does <strong>not</strong> execute anything. A <Term tip="Two-person rule: the person who proposes cannot adopt their own plan, and recovery needs a second approver.">different responder</Term> must adopt it, and each step still goes through its own control.
          </p>
          {blocked.length > 0 && <p className="text-xs text-amber-200">Unmet preconditions: {blocked.map(b => b.text).join('; ')}. You can still propose it, but the server will refuse the blocked step.</p>}
          <label className="block text-xs text-slate-400">
            Rationale (optional)
            <textarea className="input mt-1 h-16" maxLength={500} value={rationale} onChange={e => setRationale(e.target.value)} placeholder="Why this response?" />
          </label>
          <button
            className="btn-primary"
            disabled={!connected || pending !== null || !canPropose}
            onClick={() =>
              void run(
                'propose',
                c => c.reducers.proposeResponse({ incidentId: incident.incidentId, strategy: selected.strategy, targetAssetId: report.targetAssetId, rationale, stateFingerprint: report.fingerprint }),
                'Response proposed — awaiting review by another responder'
              ).then(ok => ok && setRationale(''))
            }
          >
            {pending === 'propose' ? <Loader2 className="size-4 animate-spin" /> : <Scale className="size-4" />} Propose This Response
          </button>
          {!canPropose && <p className="text-xs text-slate-500">Register as a responder to propose.</p>}
        </div>

        <div>
          <h4 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Proposals for this incident</h4>
          {list.length === 0 ? (
            <p className="text-xs text-slate-500">No proposals yet.</p>
          ) : (
            <ul className="space-y-2">
              {list.map(p => {
                const own = p.proposedBy.toHexString() === myHex;
                const stale = p.status === 'pending' && p.targetAssetId === report.targetAssetId && p.stateFingerprint !== report.fingerprint;
                return (
                  <li key={String(p.proposalId)} className="space-y-1.5 rounded-md border border-ink-700 p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-100">#{String(p.proposalId)} {STRATEGY_NAME[p.strategy as StrategyId] ?? p.strategy}</span>
                      <StatusBadge status={p.status} />
                      {p.support === 'hypothetical' && <span className="text-violet-200">hypothetical</span>}
                      {stale && <span className="text-amber-200">stale — incident changed; adoption will be refused</span>}
                    </div>
                    <div className="text-slate-400">
                      by {p.proposerName} · {fmtTime(p.createdAt)} · target {assetById.get(p.targetAssetId)?.name ?? p.targetAssetId}
                    </div>
                    <div className="text-slate-300">{p.summary}</div>
                    {p.rationale && <div className="text-slate-400 italic">“{p.rationale}”</div>}
                    {p.decisionNote && <div className="text-slate-400">Note: {p.decisionNote}</div>}
                    {p.status === 'pending' && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {own ? (
                          <>
                            <span className="text-slate-500">You proposed this — another responder must review it.</span>
                            <button className="btn-ghost px-2 py-1 text-xs" disabled={pending !== null} onClick={() => void run(`wd-${p.proposalId}`, c => c.reducers.withdrawResponseProposal({ proposalId: p.proposalId }), 'Proposal withdrawn')}>
                              Withdraw
                            </button>
                          </>
                        ) : canDecide ? (
                          <>
                            <input className="input max-w-56 py-1 text-xs" placeholder="Decision note (optional)" value={note} onChange={e => setNote(e.target.value)} aria-label="Decision note" />
                            <button className="btn-primary px-2 py-1 text-xs" disabled={pending !== null || !connected} onClick={() => void run(`adopt-${p.proposalId}`, c => c.reducers.decideResponseProposal({ proposalId: p.proposalId, adopt: true, note }), 'Plan adopted — execute its steps with the controls below').then(ok => ok && setNote(''))}>
                              Adopt plan
                            </button>
                            <button className="btn-ghost px-2 py-1 text-xs" disabled={pending !== null || !connected} onClick={() => void run(`reject-${p.proposalId}`, c => c.reducers.decideResponseProposal({ proposalId: p.proposalId, adopt: false, note }), 'Plan rejected').then(ok => ok && setNote(''))}>
                              Reject
                            </button>
                          </>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {adopted && incident.status !== 'resolved' && (
          <div className="space-y-2 border-t border-ink-700 pt-3">
            <h4 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Execute adopted plan #{String(adopted.proposalId)} with existing controls</h4>
            <p className="text-xs text-slate-400">These are the same server-checked containment and two-person recovery controls used on the incident page.</p>
            <ResponseControls incident={incident} assetId={adopted.targetAssetId} compact />
          </div>
        )}
      </div>
    </Panel>
  );
}

function Lab() {
  const data = useSentinel();
  const { incidents, evidence, assetById } = data;
  const params = useParams();
  const navigate = useNavigate();
  const open = useMemo(() => [...incidents].filter(i => i.status !== 'resolved').sort((a, b) => (a.incidentId < b.incidentId ? 1 : -1)), [incidents]);
  const incidentId = params.incidentId ? BigInt(params.incidentId.replace(/\D/g, '') || '0') : open[0]?.incidentId;
  const incident = incidents.find(i => i.incidentId === incidentId);
  const roots = useMemo(() => (incident ? rootTargets({ incidentId: String(incident.incidentId), effects: data.effects.filter(e => e.phase !== 'cleared').map(e => ({ incidentId: String(e.incidentId), assetId: e.assetId, kind: e.kind as never, level: e.level as never, phase: e.phase as never, intensity: e.intensity })) }) : []), [incident, data.effects]);
  const [target, setTarget] = useState<string>('');
  const targetAssetId = roots.includes(target) ? target : incident && roots.includes(incident.initialAssetId) ? incident.initialAssetId : (roots[0] ?? '');
  const [strategy, setStrategy] = useState<StrategyId | null>(null);
  const nameOf = (id: string) => assetById.get(id)?.name ?? id;

  const { report, error } = useMemo(() => {
    if (!incident || !targetAssetId) return { report: null, error: null };
    const input = buildLabInput(data, incident.incidentId, targetAssetId);
    if (!input) return { report: null, error: 'Incident not found' };
    try {
      return { report: evaluateAll(input), error: null };
    } catch (e) {
      return { report: null, error: e instanceof Error ? e.message : String(e) };
    }
    // Recompute only when authoritative inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident, targetAssetId, data.assets, data.dependencies, data.effects, data.recoveries]);

  // Fingerprint shown to the user so a stale preview is obvious.
  const fp = report?.fingerprint;

  if (open.length === 0 && !incident) {
    return (
      <Panel>
        <EmptyState
          icon={FlaskConical}
          title="No open incidents to compare responses for"
          hint="Launch a simulated scenario (for example “Database outage”) from Overview or Incidents, then return here to compare isolate, restore, failover and staged responses."
          action={
            <Link className="btn-primary mt-2" to="/incidents">
              Go to Incidents
            </Link>
          }
        />
      </Panel>
    );
  }

  const evidenceRows = incident ? evidence.filter(e => e.incidentId === incident.incidentId).sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1)) : [];
  const rec = report ? recommend(report, nameOf) : null;
  const selected = report?.results.find(r => r.strategy === (strategy ?? rec?.strategy ?? 'staged')) ?? report?.results[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-50">
            <FlaskConical className="size-5 text-cyan-300" aria-hidden /> Response Decision Lab
          </h1>
          <p className="max-w-3xl text-sm text-slate-400">
            Compare what each response would do to the <Term tip="A modeled copy of the infrastructure and how services depend on each other. Predictions here are about the model, not real systems.">digital twin</Term> before anyone acts. This is a{' '}
            <strong className="text-slate-200">preview</strong>: it is computed from live SpacetimeDB state and changes nothing.
          </p>
        </div>
        <label className="text-xs text-slate-400">
          Incident
          <select className="input mt-1 min-w-72" value={incident ? String(incident.incidentId) : ''} onChange={e => navigate(`/lab/${e.target.value}`)}>
            {incident && incident.status === 'resolved' && <option value={String(incident.incidentId)}>INC-{String(incident.incidentId)} (resolved)</option>}
            {open.map(i => (
              <option key={String(i.incidentId)} value={String(i.incidentId)}>
                INC-{String(i.incidentId)} · {i.title.slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!incident ? (
        <ErrorBanner title={`Incident ${params.incidentId ?? ''} not found`} detail="It may have been removed or the link is wrong. Pick an incident from the list." />
      ) : (
        <>
          <Panel title="Incident">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-slate-400">Identifier</dt>
                <dd>
                  <Link className="text-cyan-300 hover:underline" to={`/incidents/${String(incident.incidentId)}`}>
                    INC-{String(incident.incidentId)}
                  </Link>{' '}
                  {incident.isSimulation ? <SimBadge /> : <RealBadge />}
                </dd>
                <dt className="text-slate-400">Severity</dt>
                <dd>
                  <SeverityBadge severity={incident.severity} />
                </dd>
                <dt className="text-slate-400">State</dt>
                <dd>
                  <StatusBadge status={incident.status} />
                </dd>
                <dt className="text-slate-400">
                  <Term tip="The service where the problem started. Other services are affected through their dependencies on it.">Root service</Term>
                </dt>
                <dd>
                  {roots.length > 1 ? (
                    <select className="input py-1" value={targetAssetId} onChange={e => setTarget(e.target.value)} aria-label="Root service to respond to">
                      {roots.map(r => (
                        <option key={r} value={r}>
                          {nameOf(r)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-slate-200">{targetAssetId ? nameOf(targetAssetId) : nameOf(incident.initialAssetId)}</span>
                  )}
                </dd>
                <dt className="text-slate-400">Preview of</dt>
                <dd className="font-mono text-[11px] text-slate-500" title="State fingerprint; a proposal is refused if it no longer matches the server">
                  {fp ?? '—'}
                </dd>
              </dl>
              <div>
                <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Relevant evidence ({evidenceRows.length})</h3>
                {evidenceRows.length === 0 ? (
                  <p className="text-xs text-slate-500">No evidence recorded yet.</p>
                ) : (
                  <ul className="max-h-40 space-y-1 overflow-y-auto pr-1 text-xs">
                    {evidenceRows.slice(0, 12).map(e => (
                      <li key={String(e.evidenceId)} className="flex gap-2">
                        <span className="font-mono text-cyan-300">E{String(e.evidenceId)}</span>
                        <span className="text-slate-300">{e.title}</span>
                        <span className={e.synthetic ? 'text-violet-300' : 'text-emerald-300'}>{e.synthetic ? 'synthetic' : 'measured'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Panel>

          {error && <ErrorBanner title="Cannot compare responses for this incident" detail={error} />}
          {!error && !report && <EmptyState title="Nothing left to respond to" hint="This incident has no live root-cause effect. Its services are recovered or recovering." />}

          {report && selected && (
            <>
              <div role="note" className="rounded-md border border-cyan-500/30 bg-cyan-950/30 px-3 py-2 text-xs text-cyan-100">
                <span className="font-semibold">All results below are hypothetical projections on the modeled twin.</span>{' '}
                {rec ? (
                  <>
                    Engine pick: <strong>{STRATEGY_NAME[rec.strategy]}</strong> — {rec.rationale} <span className="text-cyan-300/80">(A deterministic ranking, not an order. Humans decide.)</span>
                  </>
                ) : (
                  'No strategy can be executed with existing controls; the engine makes no pick.'
                )}
              </div>
              <section aria-label="Strategy comparison" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {report.results.map(r => (
                  <StrategyCard key={r.strategy} r={r} selected={r.strategy === selected.strategy} onSelect={() => setStrategy(r.strategy)} nameOf={nameOf} picked={rec?.strategy === r.strategy} />
                ))}
              </section>
              <Panel title={`Before vs after — ${selected.name}`} actions={<SupportBadge support={selected.support} />}>
                <StrategyDetail r={selected} nameOf={nameOf} />
              </Panel>
              <div className="grid gap-4 xl:grid-cols-2">
                <ExplanationPanel incident={incident} targetAssetId={report.targetAssetId} fingerprint={report.fingerprint} />
                <ProposalsPanel incident={incident} report={report} selected={selected} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function DecisionLabPage() {
  return (
    <PageGate>
      <Lab />
    </PageGate>
  );
}
