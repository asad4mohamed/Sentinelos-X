import { useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { Bot, Database, KeyRound, RotateCcw, ScrollText, UserCog } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { useAction } from '../../hooks/useAction';
import { EmptyState, Modal, Panel } from '../../components/ui';
import { PageGate } from '../../components/PageGate';
import { CAN, ROLES, ROLE_LABEL, type Role } from '../../types/domain';
import { StatusBadge } from '../../components/StatusBadge';
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_HOST } from '../../services/spacetime';
import { fmtDateTime } from '../../lib/format';

export function SettingsPage() {
  const { ready, config, responders, audit, me, assets, dependencies, services, simulation } = useSentinel();
  const { identity, isActive } = useSpacetimeDB();
  const { run, pending } = useAction();
  const [resetOpen, setResetOpen] = useState(false);
  const isIC = !!me && CAN.administer.includes(me.role as Role);

  // PageGate shows a skeleton, or a retry message if disconnected / slow.
  if (!ready) return <PageGate>{null}</PageGate>;
  const recentAudit = [...audit].sort((a, b) => Number(b.auditId - a.auditId)).slice(0, 50);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-50">System settings</h1>
        <p className="text-sm text-slate-400">Environment, identity, roles and audit trail.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title={<span className="inline-flex items-center gap-1.5"><Database className="size-3.5" /> Environment</span>}>
          <dl className="space-y-1.5 text-xs">
            <Item k="SpacetimeDB host" v={SPACETIMEDB_HOST} />
            <Item k="Database" v={SPACETIMEDB_DB_NAME} />
            <Item k="Connection" v={isActive ? 'connected' : 'disconnected'} />
            <Item k="Environment mode" v={config?.environmentMode ?? '—'} />
            <Item k="Role self-service" v={config ? (config.devRoleSelfService ? 'enabled (dev only)' : 'disabled') : '—'} />
            <Item k="Seeded" v={config ? fmtDateTime(config.seededAt) : '—'} />
            <Item k="Simulation engine" v={simulation ? `tick #${String(simulation.tickCount)} · every ${simulation.intervalMs / 1000}s · last ${simulation.lastTickAt ? fmtDateTime(simulation.lastTickAt) : 'never'}` : 'not initialized'} />
            <Item k="Built-in telemetry" v={simulation ? (simulation.telemetryEnabled ? 'on (synthetic)' : 'off') : '—'} />
            <Item k="Assets / dependencies" v={`${assets.length} / ${dependencies.length}`} />
            <Item k="Telemetry source" v="synthetic (simulated software telemetry)" />
          </dl>
          {isIC && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-ghost" disabled={pending !== null} onClick={() => void run('seed', c => c.reducers.seedDemoInfrastructure({}), 'Demo environment synchronized (only missing services/dependencies added)')}>
                Initialize / sync demo environment
              </button>
              <button className="btn-ghost" disabled={pending !== null} onClick={() => setResetOpen(true)}>
                <RotateCcw className="size-4" /> Reset demo environment
              </button>
              <button
                className="btn-ghost"
                disabled={pending !== null || !simulation}
                onClick={() => void run('engine', c => c.reducers.setSimulationEngine({ telemetryEnabled: !simulation?.telemetryEnabled }), `Built-in telemetry ${simulation?.telemetryEnabled ? 'disabled' : 'enabled'}`)}
              >
                {simulation?.telemetryEnabled ? 'Pause' : 'Resume'} synthetic telemetry
              </button>
              <button className="btn-ghost" disabled={pending !== null || !config} onClick={() => void run('selfsvc', c => c.reducers.setDevRoleSelfService({ enabled: !config?.devRoleSelfService }), 'Setting updated')}>
                {config?.devRoleSelfService ? 'Disable' : 'Enable'} role self-service
              </button>
            </div>
          )}
        </Panel>

        <Panel title={<span className="inline-flex items-center gap-1.5"><KeyRound className="size-3.5" /> My identity</span>}>
          <dl className="space-y-1.5 text-xs">
            <Item k="Identity (this tab)" v={identity ? `${identity.toHexString().slice(0, 24)}…` : '—'} mono />
            <Item k="Display name" v={me?.displayName ?? 'not registered'} />
            <Item k="Role" v={me ? (ROLE_LABEL[me.role as Role] ?? me.role) : '—'} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            Identity is issued by SpacetimeDB and stored per browser tab. It proves continuity of a session, not who a person is — there is no SSO or verified identity yet.
          </p>
          {me && config?.devRoleSelfService && (
            <div className="mt-3 space-y-1.5">
              <div className="text-xs font-medium text-amber-300">Dev-only role self-service</div>
              <div className="flex flex-wrap gap-1.5">
                {ROLES.map(r => (
                  <button key={r} className={`rounded border px-2 py-1 text-xs ${me.role === r ? 'border-cyan-500 text-cyan-200' : 'border-ink-600 text-slate-300 hover:bg-ink-800'}`} disabled={pending !== null || me.role === r} onClick={() => void run('claim', c => c.reducers.devClaimRole({ role: r }), `Role set to ${ROLE_LABEL[r]}`)}>
                    {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel title={<span className="inline-flex items-center gap-1.5"><UserCog className="size-3.5" /> Responders & roles</span>} bodyClass="p-0">
          {responders.length === 0 ? (
            <EmptyState title="No responders registered" />
          ) : (
            <ul className="divide-y divide-ink-800">
              {responders.map(r => (
                <li key={r.identity.toHexString()} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                  <span className="truncate text-slate-200">{r.displayName}</span>
                  {isIC ? (
                    <select
                      className="input w-44 py-1 text-xs"
                      value={r.role}
                      disabled={pending !== null}
                      aria-label={`Role for ${r.displayName}`}
                      onChange={e => void run('assign', c => c.reducers.assignRole({ target: r.identity, role: e.target.value }), `Role updated for ${r.displayName}`)}
                    >
                      {ROLES.map(x => (
                        <option key={x} value={x}>
                          {ROLE_LABEL[x]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-400">{ROLE_LABEL[r.role as Role] ?? r.role}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={<span className="inline-flex items-center gap-1.5"><Bot className="size-3.5" /> Services</span>} bodyClass="p-0">
        {services.length === 0 ? (
          <EmptyState title="No services have connected" hint="Optional: the Nemotron agent (`npm --prefix services run agent`) or an external telemetry generator (only used when built-in telemetry is paused). Each announces itself here and waits for an Incident Commander to authorize it." />
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-ink-800">
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-2 py-2 font-medium">Kind</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Connection</th>
                <th className="px-2 py-2 font-medium">Identity</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {services.map(s => (
                <tr key={s.identity.toHexString()}>
                  <td className="px-4 py-2 text-slate-200">{s.name}</td>
                  <td className="px-2 py-2 text-slate-400">{s.kind === 'ai_agent' ? 'AI agent (Nemotron)' : s.kind === 'hardware_gateway' ? 'Hardware gateway (real sensors)' : 'Telemetry (synthetic)'}</td>
                  <td className="px-2 py-2">
                    <StatusBadge status={s.status === 'authorized' ? 'approved' : s.status === 'revoked' ? 'rejected' : 'pending'} />
                  </td>
                  <td className="px-2 py-2 text-slate-400">{s.online ? 'online' : `offline · ${fmtDateTime(s.lastSeenAt)}`}</td>
                  <td className="px-2 py-2 font-mono text-slate-500">{s.identity.toHexString().slice(0, 12)}…</td>
                  <td className="px-4 py-2 text-right">
                    {isIC ? (
                      s.status === 'authorized' ? (
                        <button className="btn-ghost py-1 text-xs" disabled={pending !== null} onClick={() => void run('svc', c => c.reducers.authorizeService({ target: s.identity, authorize: false }), `${s.name} revoked`)}>
                          Revoke
                        </button>
                      ) : (
                        <button className="btn-primary py-1 text-xs" disabled={pending !== null} onClick={() => void run('svc', c => c.reducers.authorizeService({ target: s.identity, authorize: true }), `${s.name} authorized`)}>
                          Authorize
                        </button>
                      )
                    ) : (
                      <span className="text-slate-600">IC only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={<span className="inline-flex items-center gap-1.5"><ScrollText className="size-3.5" /> Audit log (latest 50)</span>} bodyClass="p-0">
        {recentAudit.length === 0 ? (
          <EmptyState title="No audit events" />
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-ink-900 text-slate-500">
                <tr className="border-b border-ink-800">
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">Actor</th>
                  <th className="px-2 py-2 font-medium">Action</th>
                  <th className="px-2 py-2 font-medium">Target</th>
                  <th className="px-2 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800 font-mono">
                {recentAudit.map(a => (
                  <tr key={String(a.auditId)}>
                    <td className="px-4 py-1.5 text-slate-400">{fmtDateTime(a.timestamp)}</td>
                    <td className="px-2 py-1.5 text-slate-300">{a.actorName}</td>
                    <td className="px-2 py-1.5 text-cyan-300">{a.action}</td>
                    <td className="px-2 py-1.5 text-slate-400">
                      {a.targetType}:{a.targetId}
                    </td>
                    <td className="px-2 py-1.5 text-emerald-300">{a.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-800 px-4 py-2 text-[11px] text-slate-500">
          Only committed actions are logged. Rejected (unauthorized/invalid) calls roll back their transaction, so they return an error to the caller but are not persisted here.
        </p>
      </Panel>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset demo environment"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </button>
            <button className="btn-danger" disabled={pending !== null} onClick={() => void run('reset', c => c.reducers.resetDemoEnvironment({}), 'Demo environment reset').then(ok => ok && setResetOpen(false))}>
              Reset
            </button>
          </>
        }
      >
        <p>All injected faults are cleared and every asset returns to healthy. Active simulated incidents are closed with an explicit timeline entry.</p>
        <p className="text-xs text-slate-400">No incident, event, message or audit records are deleted. Refused if any non-simulated incident is active.</p>
      </Modal>
    </div>
  );
}

function Item({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2">
      <dt className="text-slate-500">{k}</dt>
      <dd className={`break-all text-slate-200 ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  );
}
