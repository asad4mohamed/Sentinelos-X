import { useMemo, useState } from 'react';
import { RulesAnalysisPanel } from './RulesAnalysisPanel';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bot, CheckCircle2, CircleDashed, ListChecks, Play, ShieldQuestion, Square, Terminal, UserCheck, XCircle } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { EmptyState, Panel } from '../../components/ui';
import { PageGate } from '../../components/PageGate';
import { StatusBadge } from '../../components/StatusBadge';
import { CAN, type AiInvestigation, type Role } from '../../types/domain';
import { fmtDateTime, fmtTime, relTime } from '../../lib/format';

const CONF_TONE: Record<string, string> = { high: 'text-emerald-300', medium: 'text-amber-300', low: 'text-slate-400' };

function AgentStatus() {
  const { services, me } = useSentinel();
  const { run, pending } = useAction();
  const agent = services.find(s => s.kind === 'ai_agent' && s.status !== 'revoked') ?? services.find(s => s.kind === 'ai_agent');
  const isIC = !!me && CAN.administer.includes(me.role as Role);

  let title = 'NVIDIA Nemotron agent not connected.';
  let detail = 'Start it with `npm --prefix services run agent` (needs NVIDIA_API_KEY). Nothing on this page is generated until it runs.';
  let tone = 'border-amber-500/30';
  let Icon = CircleDashed;
  if (agent?.status === 'pending') {
    title = `${agent.name} is awaiting authorization.`;
    detail = 'An Incident Commander must authorize this service identity before it can write findings.';
  } else if (agent?.status === 'revoked') {
    title = `${agent.name} has been revoked.`;
    detail = 'Its writes are rejected by the server.';
  } else if (agent?.status === 'authorized') {
    title = `${agent.name} ${agent.online ? 'online' : 'offline'}.`;
    detail = agent.online ? 'Authorized service identity. Investigations run on NVIDIA Nemotron via the NVIDIA API.' : `Last seen ${relTime(agent.lastSeenAt)}. Requests will queue until it reconnects.`;
    tone = agent.online ? 'border-emerald-500/30' : 'border-slate-600';
    Icon = Bot;
  }
  return (
    <div className={`panel flex flex-wrap items-start gap-4 p-4 ${tone}`}>
      <div className="rounded-md bg-ink-800 p-2.5 text-violet-300">
        <Icon className="size-5" />
      </div>
      <div className="min-w-60 flex-1 space-y-1">
        <div className="text-sm font-semibold text-slate-100">{title}</div>
        <p className="text-xs text-slate-400">{detail}</p>
        <p className="text-xs text-slate-500">
          The agent can only read the twin and record findings. Its recovery recommendations need human acceptance, which files a normal recovery request that still needs a
          second Incident Commander (two-person rule). All infrastructure data it analyzes is synthetic.
        </p>
      </div>
      {agent?.status === 'pending' && isIC && (
        <button className="btn-primary" disabled={pending !== null} onClick={() => void run('auth-agent', c => c.reducers.authorizeService({ target: agent.identity, authorize: true }), 'Agent authorized')}>
          <UserCheck className="size-4" /> Authorize agent
        </button>
      )}
    </div>
  );
}

export function AiInvestigatorPage() {
  const { ready, incidents, aiInvestigations, me } = useSentinel();
  const { run, pending } = useAction();
  const { investigationId } = useParams();
  const navigate = useNavigate();
  const sortedInv = useMemo(() => [...aiInvestigations].sort((a, b) => (a.investigationId < b.investigationId ? 1 : -1)), [aiInvestigations]);
  const openIncidents = incidents.filter(i => i.status !== 'resolved').sort((a, b) => (a.incidentId < b.incidentId ? 1 : -1));
  const [incidentPick, setIncidentPick] = useState('');
  const target = openIncidents.find(i => String(i.incidentId) === incidentPick) ?? openIncidents[0];
  const selected = investigationId ? sortedInv.find(i => String(i.investigationId) === investigationId) : sortedInv[0];
  const canRequest = !!me && CAN.requestAi.includes(me.role as Role);
  const activeForTarget = target && aiInvestigations.find(i => i.incidentId === target.incidentId && (i.status === 'requested' || i.status === 'running'));

  // PageGate shows a skeleton, or a retry message if disconnected / slow.
  if (!ready) return <PageGate>{null}</PageGate>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-50">AI investigator</h1>
        <p className="text-sm text-slate-400">NVIDIA Nemotron agent that investigates incidents on the digital twin with read-only tools and deterministic what-if analysis.</p>
      </div>
      <AgentStatus />
      {target && <RulesAnalysisPanel incident={target} />}

      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Panel title="Request investigation">
            {openIncidents.length === 0 ? (
              <p className="text-xs text-slate-500">No open incidents.</p>
            ) : (
              <div className="space-y-2">
                <select className="input" value={target ? String(target.incidentId) : ''} onChange={e => setIncidentPick(e.target.value)} aria-label="Incident to investigate">
                  {openIncidents.map(i => (
                    <option key={String(i.incidentId)} value={String(i.incidentId)}>
                      INC-{String(i.incidentId)} · {i.title.slice(0, 48)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-primary w-full"
                  disabled={!canRequest || !target || !!activeForTarget || pending !== null}
                  onClick={() => target && void run('ai-req', c => c.reducers.requestAiInvestigation({ incidentId: target.incidentId }), 'Investigation requested — the agent will pick it up')}
                >
                  <Play className="size-4" /> Run AI investigation
                </button>
                {!canRequest && <p className="text-xs text-slate-500">Requires Incident Commander or Security Analyst.</p>}
                {activeForTarget && <p className="text-xs text-amber-300">Investigation #{String(activeForTarget.investigationId)} is {activeForTarget.status}.</p>}
              </div>
            )}
          </Panel>
          <Panel title={`Investigation history (${sortedInv.length})`} bodyClass="p-0">
            {sortedInv.length === 0 ? (
              <EmptyState icon={Bot} title="No investigations" hint="Requested investigations and their full tool traces appear here." />
            ) : (
              <ul className="max-h-[50vh] divide-y divide-ink-800 overflow-y-auto">
                {sortedInv.map(i => (
                  <li key={String(i.investigationId)}>
                    <button
                      className={`w-full px-4 py-2.5 text-left hover:bg-ink-800 ${selected?.investigationId === i.investigationId ? 'bg-ink-800' : ''}`}
                      onClick={() => navigate(`/ai/${i.investigationId}`)}
                      aria-current={selected?.investigationId === i.investigationId}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-slate-400">
                          #{String(i.investigationId)} · INC-{String(i.incidentId)}
                        </span>
                        <InvStatus status={i.status} />
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        {i.model || 'model pending'} · {fmtDateTime(i.requestedAt)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        {selected ? <InvestigationDetail inv={selected} /> : <Panel><EmptyState title={investigationId ? `Investigation ${investigationId} not found` : 'Select or run an investigation'} /></Panel>}
      </div>
    </div>
  );
}

function InvStatus({ status }: { status: string }) {
  const map: Record<string, string> = { requested: 'pending', running: 'in_progress', completed: 'done', failed: 'rejected' };
  return <StatusBadge status={map[status] ?? status} />;
}

function InvestigationDetail({ inv }: { inv: AiInvestigation }) {
  const { aiSteps, aiFindings, responderByHex, assetById, me } = useSentinel();
  const { run, pending } = useAction();
  const steps = aiSteps.filter(s => s.investigationId === inv.investigationId).sort((a, b) => a.seq - b.seq);
  const findings = aiFindings.filter(f => f.investigationId === inv.investigationId && f.kind === 'finding');
  const recs = aiFindings.filter(f => f.investigationId === inv.investigationId && f.kind === 'recommendation');
  const canDecide = !!me && CAN.decideAiRecommendation.includes(me.role as Role);
  const active = inv.status === 'requested' || inv.status === 'running';

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-slate-500">Investigation #{String(inv.investigationId)}</span>
              <InvStatus status={inv.status} />
              <Link to={`/incidents/${inv.incidentId}`} className="font-mono text-xs text-cyan-300 hover:underline">
                INC-{String(inv.incidentId)}
              </Link>
            </div>
            <div className="text-sm text-slate-300">
              Model: <span className="font-mono text-violet-300">{inv.model || '— (not yet claimed)'}</span>
            </div>
            <div className="text-xs text-slate-500">
              Requested by {responderByHex.get(inv.requestedBy.toHexString())?.displayName ?? 'unknown'} · {fmtDateTime(inv.requestedAt)}
              {inv.startedAt && ` · started ${fmtTime(inv.startedAt)}`}
              {inv.completedAt && ` · finished ${fmtTime(inv.completedAt)}`}
            </div>
          </div>
          {active && canDecide && (
            <button className="btn-ghost" disabled={pending !== null} onClick={() => void run('ai-cancel', c => c.reducers.cancelAiInvestigation({ investigationId: inv.investigationId }), 'Investigation cancelled')}>
              <Square className="size-3.5" /> Cancel
            </button>
          )}
        </div>
        {inv.summary && (
          <div className="mt-3 rounded-md border border-violet-500/30 bg-violet-950/20 p-3">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-violet-300 uppercase">Agent summary · AI-generated, verify before acting</div>
            <p className="text-sm whitespace-pre-wrap text-slate-100">{inv.summary}</p>
          </div>
        )}
        {inv.error && <p className="mt-3 text-sm text-red-300">Failed: {inv.error}</p>}
        {inv.status === 'requested' && <p className="mt-3 text-xs text-amber-300">Waiting for an authorized, online agent to claim this investigation…</p>}
      </Panel>

      <div className="grid gap-4 2xl:grid-cols-2">
        <Panel title={<span className="inline-flex items-center gap-1.5"><Terminal className="size-3.5" /> Tool execution timeline ({steps.length})</span>} bodyClass="max-h-[60vh] overflow-y-auto p-0">
          {steps.length === 0 ? (
            <EmptyState title="No tool calls yet" />
          ) : (
            <ol className="divide-y divide-ink-800" aria-label="Agent tool calls">
              {steps.map(s => (
                <li key={String(s.stepId)} className="space-y-1 px-4 py-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-500">{s.seq}.</span>
                    {s.ok ? <CheckCircle2 className="size-3.5 text-emerald-400" aria-label="ok" /> : <XCircle className="size-3.5 text-red-400" aria-label="error" />}
                    <span className="font-mono font-semibold text-cyan-300">{s.kind === 'tool_call' ? s.tool : 'final answer'}</span>
                    <span className="ml-auto font-mono text-slate-500">{fmtTime(s.timestamp)}</span>
                  </div>
                  {s.kind === 'tool_call' && <div className="truncate font-mono text-slate-400" title={s.inputSummary}>args {s.inputSummary}</div>}
                  <div className="line-clamp-3 font-mono break-all text-slate-500" title={s.outputSummary}>
                    → {s.outputSummary}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title={<span className="inline-flex items-center gap-1.5"><ShieldQuestion className="size-3.5" /> Findings ({findings.length})</span>}>
            {findings.length === 0 ? (
              <p className="text-xs text-slate-500">No findings recorded.</p>
            ) : (
              <ul className="space-y-2.5">
                {findings.map(f => (
                  <li key={String(f.findingId)} className="text-sm">
                    <div className="text-slate-100">{f.summary}</div>
                    <div className="text-xs text-slate-500">
                      <span className={CONF_TONE[f.confidence]}>{f.confidence} confidence</span>
                      {f.assetId && ` · ${assetById.get(f.assetId)?.name ?? f.assetId}`}
                      {f.evidence && ` · evidence: ${f.evidence.slice(0, 160)}`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={<span className="inline-flex items-center gap-1.5"><ListChecks className="size-3.5" /> Recommended actions · human approval ({recs.length})</span>}>
            {recs.length === 0 ? (
              <p className="text-xs text-slate-500">No recommendations.</p>
            ) : (
              <ul className="space-y-3">
                {recs.map(f => (
                  <li key={String(f.findingId)} className="rounded border border-ink-700 p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-slate-100">{f.summary}</span>
                      <StatusBadge status={f.approvalStatus} />
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Action: restore {assetById.get(f.assetId ?? '')?.name ?? f.assetId} · <span className={CONF_TONE[f.confidence]}>{f.confidence} confidence</span>
                      {f.decidedBy && ` · decided by ${responderByHex.get(f.decidedBy.toHexString())?.displayName ?? 'unknown'}`}
                      {f.recoveryId !== undefined && (
                        <>
                          {' · '}
                          <Link className="text-cyan-300 hover:underline" to={`/command/${f.incidentId}`}>
                            recovery #{String(f.recoveryId)} awaiting 2nd commander
                          </Link>
                        </>
                      )}
                    </div>
                    {f.approvalStatus === 'pending' && canDecide && (
                      <div className="mt-2 flex gap-2">
                        <button className="btn-primary flex-1 py-1" disabled={pending !== null} onClick={() => void run(`rec-${f.findingId}`, c => c.reducers.decideAiRecommendation({ findingId: f.findingId, approve: true }), 'Accepted — recovery request filed for second-commander approval')}>
                          Accept → file recovery request
                        </button>
                        <button className="btn-ghost flex-1 py-1" disabled={pending !== null} onClick={() => void run(`rec-${f.findingId}`, c => c.reducers.decideAiRecommendation({ findingId: f.findingId, approve: false }), 'Recommendation rejected')}>
                          Reject
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
