import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Bot, CheckCircle2, Gavel, MessageSquare, Plus, Send, ShieldCheck, Users, Wrench, XCircle, FlaskConical } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { chronological } from '../../lib/derive';
import { EmptyState, Field, Modal, Panel } from '../../components/ui';
import { PageGate } from '../../components/PageGate';
import { HealthBadge, RealBadge, SeverityBadge, SimBadge, StatusBadge } from '../../components/StatusBadge';
import { Timeline } from '../../components/Timeline';
import { CAN, ROLE_LABEL, TASK_NEXT, type Incident, type Role, type TaskStatus } from '../../types/domain';
import { fmtDateTime, fmtTime, humanize, relTime } from '../../lib/format';

export function IncidentCommandPage() {
  const { ready, incidents } = useSentinel();
  const { incidentId } = useParams();
  const navigate = useNavigate();
  const sorted = useMemo(() => [...incidents].sort((a, b) => (a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch ? 1 : -1)), [incidents]);
  const incident = incidentId ? incidents.find(i => String(i.incidentId) === incidentId) : (sorted.find(i => i.status !== 'resolved') ?? sorted[0]);

  // PageGate shows a skeleton, or a retry message if disconnected / slow.
  if (!ready) return <PageGate>{null}</PageGate>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-50">Incident command</h1>
          <p className="text-sm text-slate-400">Real-time coordination workspace backed by SpacetimeDB.</p>
        </div>
        {sorted.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-slate-400">
            Incident
            <select className="input w-80 py-1.5" aria-label="Incident" value={incident ? String(incident.incidentId) : ''} onChange={e => navigate(`/command/${e.target.value}`)}>
              {sorted.map(i => (
                <option key={String(i.incidentId)} value={String(i.incidentId)}>
                  INC-{String(i.incidentId)} · {i.status} · {i.title.slice(0, 50)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
        <AlertTriangle className="size-4 shrink-0" />
        <span>
          <strong>Local development demonstration.</strong> Roles are enforced server-side against each tab's SpacetimeDB identity, but identities are anonymous
          (no SSO / verified identity) and role self-service is enabled in dev mode. Messages are real-time but <strong>not end-to-end encrypted</strong> and are readable by any
          client subscribed to this database.
        </span>
      </div>

      {!incident ? (
        <Panel>
          <EmptyState title={incidentId ? `Incident ${incidentId} not found` : 'No incidents to coordinate'} hint="Launch a simulated incident from the Overview page." />
        </Panel>
      ) : (
        <CommandRoom incident={incident} />
      )}
    </div>
  );
}

function CommandRoom({ incident }: { incident: Incident }) {
  const { incidentAssets, events, assetById, aiFindings } = useSentinel();
  const pendingAi = aiFindings.filter(f => f.incidentId === incident.incidentId && f.approvalStatus === 'pending').length;
  const affected = incidentAssets.filter(ia => ia.incidentId === incident.incidentId);
  const impactedNow = affected.filter(a => a.impactStatus !== 'recovered');
  const timeline = useMemo(() => chronological(events.filter(e => e.incidentId === incident.incidentId)).reverse(), [events, incident.incidentId]);

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-slate-500">INC-{String(incident.incidentId)}</span>
              <SeverityBadge severity={incident.severity} />
              <StatusBadge status={incident.status} />
              {incident.isSimulation ? <SimBadge /> : <RealBadge />}
            </div>
            <h2 className="text-lg font-semibold text-slate-50">{incident.title}</h2>
            <p className="text-xs text-slate-500">
              Started {fmtDateTime(incident.createdAt)} ({relTime(incident.createdAt)})
            </p>
            <Link to="/ai" className="inline-flex items-center gap-1.5 text-xs text-violet-300 hover:underline">
              <Bot className="size-3.5" /> AI investigator{pendingAi > 0 ? ` · ${pendingAi} recommendation(s) awaiting review` : ''}
            </Link>
            {incident.status !== 'resolved' && (
              <Link to={`/lab/${incident.incidentId}`} className="ml-3 inline-flex items-center gap-1.5 text-xs text-cyan-300 hover:underline">
                <FlaskConical className="size-3.5" /> Compare responses in the Decision Lab
              </Link>
            )}
          </div>
          <div className="text-right text-sm">
            <div className="text-slate-400">Current operational impact</div>
            <div className="text-2xl font-semibold text-slate-50 tabular-nums">{impactedNow.length}</div>
            <div className="text-xs text-slate-500">of {affected.length} affected assets still impacted</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {affected.map(ia => {
            const a = assetById.get(ia.assetId);
            return (
              <span key={String(ia.incidentAssetId)} className="inline-flex items-center gap-1.5 rounded border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-slate-300">
                {a?.name ?? ia.assetId}
                <span className="text-slate-500">({ia.impactType})</span>
                <HealthBadge status={ia.impactStatus === 'recovered' ? 'healthy' : (a?.healthStatus ?? 'offline')} />
              </span>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4">
          <TeamPanel />
          <RecoveryPanel incident={incident} />
        </div>
        <div className="space-y-4">
          <TasksPanel incident={incident} />
          <DecisionsPanel incident={incident} />
        </div>
        <div className="space-y-4">
          <MessagesPanel incident={incident} />
          <Panel title="Live timeline" bodyClass="max-h-96 overflow-y-auto p-4">
            {timeline.length ? <Timeline events={timeline} assetById={assetById} compact /> : <EmptyState title="No events" />}
          </Panel>
        </div>
      </div>
    </>
  );
}

function useRole() {
  const { me } = useSentinel();
  const role = me?.role as Role | undefined;
  return { me, can: (k: keyof typeof CAN) => !!role && CAN[k].includes(role) };
}

function TeamPanel() {
  const { responders, myHex } = useSentinel();
  const sorted = [...responders].sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><Users className="size-3.5" /> Response team ({responders.length})</span>} bodyClass="p-0">
      {sorted.length === 0 ? (
        <EmptyState title="No registered responders" />
      ) : (
        <ul className="divide-y divide-ink-800">
          {sorted.map(r => (
            <li key={r.identity.toHexString()} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${r.online ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-label={r.online ? 'online' : 'offline'} />
                <span className="text-slate-200">{r.displayName}</span>
                {r.identity.toHexString() === myHex && <span className="text-[10px] text-cyan-300">(you)</span>}
              </span>
              <span className="text-xs text-slate-400">{ROLE_LABEL[r.role as Role] ?? r.role}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function TasksPanel({ incident }: { incident: Incident }) {
  const { tasks, responders, responderByHex, me } = useSentinel();
  const { can } = useRole();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const list = tasks.filter(t => t.incidentId === incident.incidentId).sort((a, b) => Number(a.taskId - b.taskId));
  const active = incident.status !== 'resolved';
  const assignable = responders.filter(r => r.role !== 'observer');

  const create = async () => {
    const who = assignable.find(r => r.identity.toHexString() === assignee)?.identity;
    const ok = await run('task-create', c => c.reducers.createResponseTask({ incidentId: incident.incidentId, title, assignee: who }), 'Task created');
    if (ok) {
      setOpen(false);
      setTitle('');
      setAssignee('');
    }
  };

  return (
    <Panel
      title="Response tasks"
      actions={
        active && can('createTask') ? (
          <button className="btn-ghost py-1" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> Task
          </button>
        ) : undefined
      }
      bodyClass="p-0"
    >
      {list.length === 0 ? (
        <EmptyState title="No tasks yet" />
      ) : (
        <ul className="divide-y divide-ink-800">
          {list.map(t => {
            const mine = !!me && t.assignedTo?.toHexString() === me.identity.toHexString();
            const mayUpdate = active && (mine || can('createTask'));
            return (
              <li key={String(t.taskId)} className="space-y-1.5 px-4 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm text-slate-100">{t.title}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div className="text-xs text-slate-500">
                  #{String(t.taskId)} · {t.assignedTo ? (responderByHex.get(t.assignedTo.toHexString())?.displayName ?? 'unknown') : 'unassigned'} · updated {fmtTime(t.updatedAt)}
                  {t.completedAt && ` · done ${fmtTime(t.completedAt)}`}
                </div>
                {mayUpdate && (
                  <div className="flex flex-wrap gap-1">
                    {TASK_NEXT[t.status as TaskStatus]?.map(s => (
                      <button key={s} className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-ink-800 disabled:opacity-50" disabled={pending !== null} onClick={() => void run(`task-${t.taskId}`, c => c.reducers.updateResponseTask({ taskId: t.taskId, status: s }))}>
                        → {humanize(s)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create response task"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={create} disabled={pending !== null || title.trim().length < 3}>
              Create
            </button>
          </>
        }
      >
        <Field label="Title">
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={140} placeholder="Verify integrity of offsite backups" />
        </Field>
        <Field label="Assignee">
          <select className="input" aria-label="Assignee" value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {assignable.map(r => (
              <option key={r.identity.toHexString()} value={r.identity.toHexString()}>
                {r.displayName} ({ROLE_LABEL[r.role as Role]})
              </option>
            ))}
          </select>
        </Field>
      </Modal>
    </Panel>
  );
}

function DecisionsPanel({ incident }: { incident: Incident }) {
  const { decisions } = useSentinel();
  const { can } = useRole();
  const { run, pending } = useAction();
  const [summary, setSummary] = useState('');
  const [rationale, setRationale] = useState('');
  const list = decisions.filter(d => d.incidentId === incident.incidentId).sort((a, b) => Number(b.decisionId - a.decisionId));

  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><Gavel className="size-3.5" /> Decision log</span>}>
      {incident.status !== 'resolved' && can('recordDecision') && (
        <form
          className="mb-3 space-y-2"
          onSubmit={e => {
            e.preventDefault();
            void run('decision', c => c.reducers.recordIncidentDecision({ incidentId: incident.incidentId, summary, rationale }), 'Decision recorded').then(ok => {
              if (ok) {
                setSummary('');
                setRationale('');
              }
            });
          }}
        >
          <input className="input" value={summary} onChange={e => setSummary(e.target.value)} placeholder="Decision summary" maxLength={160} aria-label="Decision summary" />
          <textarea className="input" rows={2} value={rationale} onChange={e => setRationale(e.target.value)} placeholder="Rationale" maxLength={1000} aria-label="Decision rationale" />
          <button className="btn-ghost w-full" disabled={pending !== null || summary.trim().length < 3 || rationale.trim().length < 3}>
            Record decision
          </button>
        </form>
      )}
      {list.length === 0 ? (
        <p className="text-xs text-slate-500">No decisions recorded{!can('recordDecision') ? ' (Incident Commander or Legal Responder can record).' : '.'}</p>
      ) : (
        <ul className="space-y-2.5">
          {list.map(d => (
            <li key={String(d.decisionId)} className="rounded border border-ink-700 p-2.5">
              <div className="text-sm font-medium text-slate-100">{d.summary}</div>
              <p className="mt-0.5 text-xs whitespace-pre-wrap text-slate-400">{d.rationale}</p>
              <div className="mt-1 text-[11px] text-slate-500">
                {d.actorName} · {ROLE_LABEL[d.actorRole as Role] ?? d.actorRole} · {fmtDateTime(d.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MessagesPanel({ incident }: { incident: Incident }) {
  const { messages, myHex } = useSentinel();
  const { can } = useRole();
  const { run, pending } = useAction();
  const [body, setBody] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const list = useMemo(() => messages.filter(m => m.incidentId === incident.incidentId).sort((a, b) => Number(a.messageId - b.messageId)), [messages, incident.incidentId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [list.length]);
  const canSend = incident.status !== 'resolved' && can('sendMessage');

  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><MessageSquare className="size-3.5" /> Communications</span>} bodyClass="flex flex-col p-0">
      <div className="max-h-80 min-h-40 flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite">
        {list.length === 0 && <p className="text-center text-xs text-slate-500">No messages yet.</p>}
        {list.map(m => {
          const mine = m.sender.toHexString() === myHex;
          return (
            <div key={String(m.messageId)} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${mine ? 'bg-cyan-500/15 text-cyan-50' : 'bg-ink-800 text-slate-100'}`}>{m.body}</div>
              <span className="mt-0.5 text-[10px] text-slate-500">
                {m.senderName} · {ROLE_LABEL[m.senderRole as Role] ?? m.senderRole} · {fmtTime(m.createdAt)}
              </span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {canSend ? (
        <form
          className="flex gap-2 border-t border-ink-700 p-2"
          onSubmit={e => {
            e.preventDefault();
            const text = body;
            void run('msg', c => c.reducers.sendIncidentMessage({ incidentId: incident.incidentId, body: text })).then(ok => ok && setBody(''));
          }}
        >
          <input className="input" value={body} onChange={e => setBody(e.target.value)} placeholder="Message the response team" maxLength={1000} aria-label="Message" />
          <button className="btn-primary" disabled={pending === 'msg' || body.trim().length === 0} aria-label="Send message">
            <Send className="size-4" />
          </button>
        </form>
      ) : (
        <p className="border-t border-ink-700 p-2 text-center text-xs text-slate-500">{incident.status === 'resolved' ? 'Incident resolved — channel read-only.' : 'Observers have read-only access.'}</p>
      )}
    </Panel>
  );
}

function RecoveryPanel({ incident }: { incident: Incident }) {
  const { recoveries, assetById, responderByHex, myHex, effects } = useSentinel();
  const { can } = useRole();
  const { run, pending } = useAction();
  const [note, setNote] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const list = recoveries.filter(r => r.incidentId === incident.incidentId).sort((a, b) => Number(b.recoveryId - a.recoveryId));
  const stillFailedIds = [...new Set(effects.filter(e => e.incidentId === incident.incidentId && (e.phase === 'active' || e.phase === 'contained')).map(e => e.assetId))];
  const stillFailed = stillFailedIds.map(id => assetById.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  const pendingCount = list.filter(r => r.status === 'pending').length;
  const resolvable = stillFailed.length === 0 && pendingCount === 0;

  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> Recovery & approval</span>}>
      <p className="mb-2 text-xs text-slate-400">
        Recovery is requested from the incident page or the Digital Twin inspector and must be approved by an Incident Commander <em>other than the requester</em>. Approved services pass through <span className="text-sky-300">Recovering</span> before returning to healthy. Restoration is simulated.
      </p>
      {stillFailed.length > 0 && (
        <div className="mb-3 text-xs text-red-300">
          Root-cause assets still down: {stillFailed.map(a => a.name).join(', ')}
        </div>
      )}
      {list.length === 0 ? (
        <p className="text-xs text-slate-500">No recovery actions requested.</p>
      ) : (
        <ul className="space-y-2">
          {list.map(r => {
            const own = r.requestedBy.toHexString() === myHex;
            return (
              <li key={String(r.recoveryId)} className="rounded border border-ink-700 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm text-slate-100">
                    <Wrench className="size-3.5" /> {assetById.get(r.assetId)?.name ?? r.assetId}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <p className="mt-1 text-slate-400">{r.plan}</p>
                <div className="mt-1 text-slate-500">
                  Requested by {responderByHex.get(r.requestedBy.toHexString())?.displayName ?? 'unknown'} · {fmtTime(r.requestedAt)}
                  {r.decidedBy && ` · decided by ${responderByHex.get(r.decidedBy.toHexString())?.displayName ?? 'unknown'}`}
                  {r.decisionNote && ` — ${r.decisionNote}`}
                </div>
                {r.status === 'pending' && can('decideRecovery') && (
                  own ? (
                    <p className="mt-2 text-amber-300">Two-person rule: a different responder must decide.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      <input className="input py-1 text-xs" value={note} onChange={e => setNote(e.target.value)} placeholder="Decision note (optional)" maxLength={500} aria-label="Decision note" />
                      <div className="flex gap-2">
                        <button className="btn-primary flex-1 py-1" disabled={pending !== null} onClick={() => void run(`rec-${r.recoveryId}`, c => c.reducers.decideRecovery({ recoveryId: r.recoveryId, approve: true, note }), 'Recovery approved — twin recomputed').then(ok => ok && setNote(''))}>
                          <CheckCircle2 className="size-3.5" /> Approve
                        </button>
                        <button className="btn-ghost flex-1 py-1" disabled={pending !== null} onClick={() => void run(`rec-${r.recoveryId}`, c => c.reducers.decideRecovery({ recoveryId: r.recoveryId, approve: false, note }), 'Recovery rejected').then(ok => ok && setNote(''))}>
                          <XCircle className="size-3.5" /> Reject
                        </button>
                      </div>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {incident.status !== 'resolved' && can('resolveIncident') && (
        <div className="mt-3 border-t border-ink-700 pt-3">
          <button className="btn-ghost w-full" disabled={!resolvable || pending !== null} onClick={() => setResolveOpen(true)} title={resolvable ? undefined : 'Recover all root-cause assets and settle pending recoveries first'}>
            <CheckCircle2 className="size-4" /> Resolve incident
          </button>
        </div>
      )}
      <Modal
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title={`Resolve INC-${incident.incidentId}`}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setResolveOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={pending !== null || summary.trim().length < 5}
              onClick={() => void run('resolve', c => c.reducers.resolveIncident({ incidentId: incident.incidentId, summary }), 'Incident resolved').then(ok => ok && setResolveOpen(false))}
            >
              Resolve
            </button>
          </>
        }
      >
        <Field label="Resolution summary">
          <textarea className="input" rows={3} value={summary} onChange={e => setSummary(e.target.value)} maxLength={1000} placeholder="Database restored from offsite vault snapshot; no data loss confirmed." />
        </Field>
      </Modal>
    </Panel>
  );
}
