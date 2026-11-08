// Runs the real module reducers (and the scheduled simulation tick) in the
// SpacetimeDB test harness and exports the resulting rows as a JSON fixture for
// frontend render tests. Only active when EXPORT_SCENARIO=<output path> is set.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { ConnectionId, Identity, ScheduleAt, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from '../src/index';

const out = process.env.EXPORT_SCENARIO;
const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-fixture', sub }), new ConnectionId(c));

function encode(v: unknown): unknown {
  // Duck-typed: the harness may load a separate copy of the SDK classes.
  if (v instanceof Identity || (v && typeof v === 'object' && '__identity__' in v)) return { __identity: (v as Identity).toHexString() };
  if (v instanceof Timestamp || (v && typeof v === 'object' && '__timestamp_micros_since_unix_epoch__' in v))
    return { __ts: (v as Timestamp).microsSinceUnixEpoch.toString() };
  if (typeof v === 'bigint') return { __big: v.toString() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === undefined ? null : encode(x)]));
  return v;
}

it.skipIf(!out)('exports Phase 2 scenario fixture', () => {
  const h = createModuleTestHarness(spacetime, m);
  // Anchor near "now" so relative times in the UI read naturally.
  let t = BigInt(Date.now()) * 1000n - 300_000_000n;
  const step = () => h.clock.set(new Timestamp((t += 2_000_000n)));
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      t += 3_000_000n;
      h.clock.set(new Timestamp(t));
      h.withReducerTx(TestAuth.internal(), ctx => m.simulation_tick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(3_000_000n) } }));
    }
  };
  const ic = auth('ada', 1n), an = auth('ben', 2n), lg = auth('lee', 3n), ag = auth('agent', 5n);
  step(); h.withReducerTx(ic, ctx => m.init(ctx, {}));
  step(); h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'Ada (IC)' }));
  step(); h.withReducerTx(an, ctx => { m.register_responder(ctx, { displayName: 'Ben (Analyst)' }); m.dev_claim_role(ctx, { role: 'security_analyst' }); });
  step(); h.withReducerTx(lg, ctx => { m.register_responder(ctx, { displayName: 'Lee (Legal)' }); m.dev_claim_role(ctx, { role: 'legal_responder' }); });
  tick(8);

  // A — auth compromise: contained, recovery requested by Ben (awaits Ada).
  step(); h.withReducerTx(an, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'auth_compromise', title: '' }));
  const auth1 = [...h.db.incident.iter()].find(i => i.scenarioType === 'auth_compromise')!.incidentId;
  tick(3);
  step(); h.withReducerTx(an, ctx => m.apply_containment(ctx, { incidentId: auth1, assetId: 'auth-svc' }));
  step(); h.withReducerTx(an, ctx => m.request_recovery(ctx, { incidentId: auth1, assetId: 'auth-svc', plan: 'Rotate signing keys and credentials, redeploy the authentication service from a clean image (simulated).' }));

  // B — database outage: active.
  step(); h.withReducerTx(an, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'database_outage', title: '' }));
  const db = [...h.db.incident.iter()].find(i => i.scenarioType === 'database_outage')!.incidentId;
  step(); h.withReducerTx(an, ctx => m.update_incident_status(ctx, { incidentId: db, status: 'investigating' }));
  const benId = [...h.db.responder.iter()].find(r => r.displayName.startsWith('Ben'))!.identity;
  step(); h.withReducerTx(ic, ctx => m.create_response_task(ctx, { incidentId: db, title: 'Fail over to standby replica', assignee: benId }));
  step(); h.withReducerTx(ic, ctx => m.record_incident_decision(ctx, { incidentId: db, summary: 'Freeze deploys during database recovery', rationale: 'Avoid schema drift while restoring from snapshot.' }));
  step(); h.withReducerTx(an, ctx => m.send_incident_message(ctx, { incidentId: db, body: 'Primary heartbeat lost; standby lagging.' }));
  step(); h.withReducerTx(lg, ctx => m.send_incident_message(ctx, { incidentId: db, body: 'Tracking customer-impact window for notification.' }));

  // C — traffic surge: saturates after a few ticks.
  step(); h.withReducerTx(an, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'traffic_surge', title: '' }));
  tick(4);

  // AI investigation driven through agent reducers with SCRIPTED test content (no model involved).
  let agentId: Identity | undefined;
  step(); h.withReducerTx(ag, ctx => { agentId = ctx.sender; m.announce_service(ctx, { name: 'Nemotron Investigator', kind: 'ai_agent' }); });
  step(); h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: agentId!, authorize: true }));
  step(); h.withReducerTx(an, ctx => m.request_ai_investigation(ctx, { incidentId: db }));
  const invId = [...h.db.aiInvestigation.iter()][0]!.investigationId;
  step(); h.withReducerTx(ag, ctx => m.agent_claim_investigation(ctx, { investigationId: invId, model: 'test-fixture-model' }));
  step(); h.withReducerTx(ag, ctx => m.agent_record_step(ctx, { investigationId: invId, kind: 'tool_call', tool: 'get_incident', inputSummary: '{}', outputSummary: '{"affected":7}', ok: true }));
  step(); h.withReducerTx(ag, ctx => m.agent_record_step(ctx, { investigationId: invId, kind: 'tool_call', tool: 'simulate_recovery', inputSummary: '{"asset_id":"primary-db"}', outputSummary: '{"wouldReturnToHealthy":["primary-db","auth-svc","app-api"]}', ok: true }));
  step(); h.withReducerTx(ag, ctx => m.agent_record_finding(ctx, { investigationId: invId, kind: 'finding', summary: 'Fixture finding: primary-db is the root cause', evidence: 'get_incident', assetId: 'primary-db', confidence: 'high' }));
  step(); h.withReducerTx(ag, ctx => m.agent_record_finding(ctx, { investigationId: invId, kind: 'recommendation', summary: 'Fixture recommendation: restore Primary Database first', evidence: 'simulate_recovery', assetId: 'primary-db', confidence: 'high' }));
  step(); h.withReducerTx(ag, ctx => m.agent_complete_investigation(ctx, { investigationId: invId, summary: 'Fixture summary (scripted test data, not model output).', failed: false }));
  tick(2);

  const dump = (rows: Iterable<unknown>) => [...rows].map(encode);
  const fixture = {
    myIdentity: [...h.db.responder.iter()].find(r => r.displayName.startsWith('Ada'))!.identity.toHexString(),
    asset: dump(h.db.asset.iter()), dependency: dump(h.db.dependency.iter()), incident: dump(h.db.incident.iter()),
    incidentAsset: dump(h.db.incidentAsset.iter()), incidentEvent: dump(h.db.incidentEvent.iter()), responseTask: dump(h.db.responseTask.iter()),
    incidentDecision: dump(h.db.incidentDecision.iter()), incidentMessage: dump(h.db.incidentMessage.iter()), recoveryAction: dump(h.db.recoveryAction.iter()),
    auditEvent: dump(h.db.auditEvent.iter()), responder: dump(h.db.responder.iter()), systemConfig: dump(h.db.systemConfig.iter()),
    servicePrincipal: dump(h.db.servicePrincipal.iter()), telemetrySample: dump(h.db.telemetrySample.iter()),
    aiInvestigation: dump(h.db.aiInvestigation.iter()), aiStep: dump(h.db.aiStep.iter()), aiFinding: dump(h.db.aiFinding.iter()),
    incidentEffect: dump(h.db.incidentEffect.iter()), incidentEvidence: dump(h.db.incidentEvidence.iter()),
    telemetryMetric: dump(h.db.telemetryMetric.iter()), simulationState: dump(h.db.simulationState.iter()),
  };
  writeFileSync(out!, JSON.stringify(fixture));
});
