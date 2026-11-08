// Service principals, synthetic telemetry ingestion and the AI investigation
// lifecycle, executed on SpacetimeDB's module test harness.
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';

const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub }), new ConnectionId(c));

function setup() {
  const h = createModuleTestHarness(spacetime, m);
  h.clock.set(new Timestamp(1_700_000_000_000_000n));
  const ic = auth('ic', 1n), ic2 = auth('ic2', 2n), analyst = auth('an', 3n), tel = auth('telemetry', 4n), agent = auth('agent', 5n), rogue = auth('rogue', 6n);
  h.withReducerTx(ic, ctx => m.init(ctx, {}));
  h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'Ada' }));
  h.withReducerTx(ic2, ctx => { m.register_responder(ctx, { displayName: 'Cy' }); m.dev_claim_role(ctx, { role: 'incident_commander' }); });
  h.withReducerTx(analyst, ctx => { m.register_responder(ctx, { displayName: 'Ben' }); m.dev_claim_role(ctx, { role: 'security_analyst' }); });
  let telId: Identity | undefined, agentId: Identity | undefined;
  h.withReducerTx(tel, ctx => { telId = ctx.sender; m.announce_service(ctx, { name: 'Telemetry Generator', kind: 'telemetry' }); });
  h.withReducerTx(agent, ctx => { agentId = ctx.sender; m.announce_service(ctx, { name: 'Nemotron Investigator', kind: 'ai_agent' }); });
  return { h, ic, ic2, analyst, tel, agent, rogue, telId: telId!, agentId: agentId! };
}

const sample = (assetId: string, latencyMs = 40) => ({ assetId, latencyMs, errorRate: 0.01, cpuPct: 30, throughputRpm: 1200 });

describe('service principals', () => {
  it('start pending and are rejected until an IC authorizes them', () => {
    const { h, ic, analyst, tel, telId } = setup();
    expect(h.db.servicePrincipal.identity.find(telId)?.status).toBe('pending');
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('app-api')] }))).toThrow(/pending/);
    expect(() => h.withReducerTx(analyst, ctx => m.authorize_service(ctx, { target: telId, authorize: true }))).toThrow(/Unauthorized/);
    h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: telId, authorize: true }));
    // External generators are only accepted while the built-in engine is off.
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('app-api')] }))).toThrow(/Built-in simulation engine/);
    h.withReducerTx(ic, ctx => m.set_simulation_engine(ctx, { telemetryEnabled: false }));
    h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('app-api')] }));
    h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: telId, authorize: false }));
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('app-api')] }))).toThrow(/revoked/);
  });

  it('keep service and responder identities separate', () => {
    const { h, tel, ic } = setup();
    expect(() => h.withReducerTx(tel, ctx => m.register_responder(ctx, { displayName: 'Sneaky' }))).toThrow(/Service identities/);
    expect(() => h.withReducerTx(ic, ctx => m.announce_service(ctx, { name: 'Fake agent', kind: 'ai_agent' }))).toThrow(/Responder identities/);
  });
});

describe('telemetry ingestion', () => {
  it('validates, stores a rolling window and never changes health', () => {
    const { h, ic, tel, telId } = setup();
    h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: telId, authorize: true }));
    h.withReducerTx(ic, ctx => m.set_simulation_engine(ctx, { telemetryEnabled: false }));
    for (let i = 0; i < 35; i++) {
      h.clock.set(new Timestamp(1_700_000_000_000_000n + BigInt(i + 1) * 2_000_000n));
      h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('app-api', 40 + i), sample('primary-db')] }));
    }
    const api = [...h.db.telemetrySample.assetId.filter('app-api')];
    expect(api).toHaveLength(30);
    expect(Math.min(...api.map(s => s.latencyMs))).toBe(45); // oldest 5 pruned
    expect(h.db.asset.assetId.find('app-api')?.healthStatus).toBe('healthy');
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [{ ...sample('app-api'), errorRate: 2 }] }))).toThrow(/errorRate/);
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('nope-asset')] }))).toThrow(/not found/);
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [sample('app-api'), sample('app-api')] }))).toThrow(/Duplicate/);
    expect(() => h.withReducerTx(tel, ctx => m.ingest_telemetry(ctx, { samples: [{ ...sample('app-api'), latencyMs: Number.NaN }] }))).toThrow(/latencyMs/);
  });
});

describe('AI investigation lifecycle', () => {
  function withIncident() {
    const s = setup();
    s.h.withReducerTx(s.ic, ctx => m.authorize_service(ctx, { target: s.agentId, authorize: true }));
    s.h.withReducerTx(s.analyst, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'simulated_ransomware', title: '' }));
    const incidentId = [...s.h.db.incident.iter()][0]!.incidentId;
    s.h.withReducerTx(s.analyst, ctx => m.request_ai_investigation(ctx, { incidentId }));
    const investigationId = [...s.h.db.aiInvestigation.iter()][0]!.investigationId;
    return { ...s, incidentId, investigationId };
  }

  it('runs request → claim → steps → findings → complete', () => {
    const { h, agent, analyst, incidentId, investigationId } = withIncident();
    expect(() => h.withReducerTx(analyst, ctx => m.request_ai_investigation(ctx, { incidentId }))).toThrow(/already requested/);
    h.withReducerTx(agent, ctx => m.agent_claim_investigation(ctx, { investigationId, model: 'nvidia/nemotron-3-super-120b-a12b' }));
    expect(h.db.aiInvestigation.investigationId.find(investigationId)?.status).toBe('running');
    h.withReducerTx(agent, ctx => m.agent_record_step(ctx, { investigationId, kind: 'tool_call', tool: 'get_incident', inputSummary: '{}', outputSummary: 'ok', ok: true }));
    h.withReducerTx(agent, ctx => m.agent_record_finding(ctx, { investigationId, kind: 'finding', summary: 'Root cause is primary-db', evidence: 'direct failure', assetId: 'primary-db', confidence: 'high' }));
    h.withReducerTx(agent, ctx => m.agent_record_finding(ctx, { investigationId, kind: 'recommendation', summary: 'Restore primary-db from vault', evidence: 'backup path healthy', assetId: 'primary-db', confidence: 'high' }));
    h.withReducerTx(agent, ctx => m.agent_complete_investigation(ctx, { investigationId, summary: 'Done', failed: false }));
    const inv = h.db.aiInvestigation.investigationId.find(investigationId)!;
    expect(inv.status).toBe('completed');
    expect([...h.db.aiStep.investigationId.filter(investigationId)]).toHaveLength(1);
    const findings = [...h.db.aiFinding.investigationId.filter(investigationId)];
    expect(findings.map(f => f.approvalStatus).sort()).toEqual(['not_required', 'pending']);
    expect([...h.db.incidentEvent.incidentId.filter(incidentId)].some(e => e.eventType === 'ai_investigation_completed')).toBe(true);
    // Nothing was restored by the agent.
    expect(h.db.asset.assetId.find('primary-db')?.directFailure).toBe('offline');
  });

  it('rejects unauthorized or out-of-scope agent writes', () => {
    const { h, agent, rogue, investigationId } = withIncident();
    expect(() => h.withReducerTx(rogue, ctx => m.agent_claim_investigation(ctx, { investigationId, model: 'x-model' }))).toThrow(/not a registered ai_agent/);
    expect(() => h.withReducerTx(agent, ctx => m.agent_record_step(ctx, { investigationId, kind: 'tool_call', tool: 'x', inputSummary: '', outputSummary: '', ok: true }))).toThrow(/requested/);
    h.withReducerTx(agent, ctx => m.agent_claim_investigation(ctx, { investigationId, model: 'nvidia/nemotron-3-super-120b-a12b' }));
    expect(() =>
      h.withReducerTx(agent, ctx => m.agent_record_finding(ctx, { investigationId, kind: 'recommendation', summary: 'Restore the backup vault', evidence: '', assetId: 'backup-vault', confidence: 'low' }))
    ).toThrow(/root-cause/);
    expect(() =>
      h.withReducerTx(agent, ctx => m.agent_record_finding(ctx, { investigationId, kind: 'finding', summary: 'whatever text', evidence: '', assetId: undefined, confidence: 'certain' }))
    ).toThrow(/confidence/);
  });

  it('approved recommendation becomes a human recovery request that still needs a second commander', () => {
    const { h, agent, analyst, ic, incidentId, investigationId } = withIncident();
    h.withReducerTx(agent, ctx => m.agent_claim_investigation(ctx, { investigationId, model: 'nvidia/nemotron-3-super-120b-a12b' }));
    h.withReducerTx(agent, ctx => m.agent_record_finding(ctx, { investigationId, kind: 'recommendation', summary: 'Restore primary-db from vault', evidence: 'e', assetId: 'primary-db', confidence: 'high' }));
    const findingId = [...h.db.aiFinding.iter()][0]!.findingId;
    h.withReducerTx(ic, ctx => m.decide_ai_recommendation(ctx, { findingId, approve: true }));
    const f = h.db.aiFinding.findingId.find(findingId)!;
    expect(f.approvalStatus).toBe('approved');
    const rec = h.db.recoveryAction.recoveryId.find(f.recoveryId!)!;
    expect(rec.status).toBe('pending');
    expect(rec.incidentId).toBe(incidentId);
    // The approving commander filed it, so they cannot also approve the recovery.
    expect(() => h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rec.recoveryId, approve: true, note: '' }))).toThrow(/Two-person/);
    expect(() => h.withReducerTx(analyst, ctx => m.decide_ai_recommendation(ctx, { findingId, approve: true }))).toThrow(/already approved/);
  });

  it('cancel and reset stop in-flight investigations', () => {
    const { h, analyst, ic, investigationId, incidentId } = withIncident();
    h.withReducerTx(analyst, ctx => m.cancel_ai_investigation(ctx, { investigationId }));
    expect(h.db.aiInvestigation.investigationId.find(investigationId)?.status).toBe('failed');
    h.withReducerTx(analyst, ctx => m.request_ai_investigation(ctx, { incidentId }));
    h.withReducerTx(ic, ctx => m.reset_demo_environment(ctx, {}));
    expect([...h.db.aiInvestigation.iter()].every(i => i.status === 'failed')).toBe(true);
  });
});
