// Decision Lab reducers on SpacetimeDB's in-process module harness (real datastore, not mocks).
import { describe, expect, it } from 'vitest';
import { ConnectionId, ScheduleAt, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';
import { stateFingerprint, type LabInput } from './decisionLab';

const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub }), new ConnectionId(c));

function setup() {
  const h = createModuleTestHarness(spacetime, m);
  h.clock.set(new Timestamp(1_700_000_000_000_000n));
  const ada = auth('ada', 1n);
  const ben = auth('ben', 2n);
  const stranger = auth('stranger', 3n);
  const agent = auth('agent', 4n);
  h.withReducerTx(ada, ctx => m.init(ctx, {}));
  h.withReducerTx(ada, ctx => m.register_responder(ctx, { displayName: 'Ada Commander' }));
  h.withReducerTx(ben, ctx => {
    m.register_responder(ctx, { displayName: 'Ben Analyst' });
    m.dev_claim_role(ctx, { role: 'security_analyst' });
  });
  h.withReducerTx(agent, ctx => m.announce_service(ctx, { name: 'Nemotron Investigator', kind: 'ai_agent' }));
  const agentId = [...h.db.servicePrincipal.iter()][0]!.identity;
  h.withReducerTx(ada, ctx => m.authorize_service(ctx, { target: agentId, authorize: true }));
  h.withReducerTx(ada, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'database_outage', title: '' }));
  const incidentId = [...h.db.incident.iter()][0]!.incidentId;
  return { h, ada, ben, stranger, agent, incidentId };
}

/** The fingerprint a client would compute from its subscribed rows. */
function clientFingerprint(h: ReturnType<typeof setup>['h'], incidentId: bigint): string {
  const inc = h.db.incident.incidentId.find(incidentId)!;
  const input: Pick<LabInput, 'incidentId' | 'incidentStatus' | 'effects' | 'edges' | 'assets'> = {
    incidentId: String(incidentId),
    incidentStatus: inc.status,
    assets: [...h.db.asset.iter()].map(a => ({ assetId: a.assetId, name: a.name, criticality: a.criticality as never })),
    edges: [...h.db.dependency.iter()].map(d => ({ dependentAssetId: d.dependentAssetId, requiredAssetId: d.requiredAssetId, dependencyType: d.dependencyType as never })),
    effects: [...h.db.incidentEffect.iter()].filter(e => e.phase !== 'cleared').map(e => ({ incidentId: String(e.incidentId), assetId: e.assetId, kind: e.kind as never, level: e.level as never, phase: e.phase as never, intensity: e.intensity })),
  };
  return stateFingerprint(input);
}

const tick = (h: ReturnType<typeof setup>['h'], n = 1) => {
  for (let i = 0; i < n; i++) h.withReducerTx(TestAuth.internal(), ctx => m.simulation_tick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(3_000_000n) } }));
};

describe('propose_response', () => {
  it('stores a server-computed proposal without changing infrastructure state', () => {
    const { h, ben, incidentId } = setup();
    const assetsBefore = JSON.stringify([...h.db.asset.iter()].map(a => [a.assetId, a.healthStatus]));
    const fp = clientFingerprint(h, incidentId);
    h.withReducerTx(ben, ctx => m.propose_response(ctx, { incidentId, strategy: 'restore', targetAssetId: 'primary-db', rationale: 'DB is the single root cause', stateFingerprint: fp }));
    const p = [...h.db.responseProposal.iter()][0]!;
    expect(p.status).toBe('pending');
    expect(p.support).toBe('executable');
    expect(p.summary).toMatch(/restores: .*Primary Database/);
    expect(JSON.stringify([...h.db.asset.iter()].map(a => [a.assetId, a.healthStatus]))).toBe(assetsBefore);
    expect([...h.db.recoveryAction.iter()]).toHaveLength(0); // nothing executed
    expect([...h.db.incidentEvent.iter()].some(e => e.eventType === 'response_proposed')).toBe(true);
    expect([...h.db.auditEvent.iter()].some(a => a.action === 'propose_response:restore')).toBe(true);
  });

  it('labels failover as hypothetical', () => {
    const { h, ben, incidentId } = setup();
    const fp = clientFingerprint(h, incidentId);
    h.withReducerTx(ben, ctx => m.propose_response(ctx, { incidentId, strategy: 'failover', targetAssetId: 'primary-db', rationale: '', stateFingerprint: fp }));
    expect([...h.db.responseProposal.iter()][0]!.support).toBe('hypothetical');
  });

  it('rejects stale previews, unknown strategies, non-root targets, unregistered callers and duplicates', () => {
    const { h, ben, stranger, incidentId } = setup();
    const fp = clientFingerprint(h, incidentId);
    const propose = (who: TestAuth, args: Partial<Parameters<typeof m.propose_response>[1]> = {}) =>
      h.withReducerTx(who, ctx => m.propose_response(ctx, { incidentId, strategy: 'restore', targetAssetId: 'primary-db', rationale: '', stateFingerprint: fp, ...args }));
    expect(() => propose(ben, { stateFingerprint: 'open-00000000-00000000' })).toThrow(/Stale proposal/);
    expect(() => propose(ben, { strategy: 'delete_database' })).toThrow(/Invalid strategy/);
    expect(() => propose(ben, { targetAssetId: 'app-api' })).toThrow(/not a live root cause/);
    expect(() => propose(ben, { targetAssetId: 'nope' })).toThrow(/not found/);
    expect(() => propose(stranger)).toThrow(/Unauthorized/);
    propose(ben);
    expect(() => propose(ben)).toThrow(/already pending/);
  });
});

describe('decide_response_proposal', () => {
  it('enforces two-person review and adoption executes nothing', () => {
    const { h, ada, ben, incidentId } = setup();
    const fp = clientFingerprint(h, incidentId);
    h.withReducerTx(ben, ctx => m.propose_response(ctx, { incidentId, strategy: 'restore', targetAssetId: 'primary-db', rationale: '', stateFingerprint: fp }));
    const id = [...h.db.responseProposal.iter()][0]!.proposalId;
    expect(() => h.withReducerTx(ben, ctx => m.decide_response_proposal(ctx, { proposalId: id, adopt: true, note: '' }))).toThrow(/Two-person rule/);
    h.withReducerTx(ada, ctx => m.decide_response_proposal(ctx, { proposalId: id, adopt: true, note: 'Go' }));
    expect(h.db.responseProposal.proposalId.find(id)!.status).toBe('adopted');
    expect([...h.db.incidentDecision.iter()].some(d => /Adopted response plan/.test(d.summary))).toBe(true);
    expect([...h.db.recoveryAction.iter()]).toHaveLength(0);
    expect(h.db.asset.assetId.find('primary-db')!.healthStatus).toBe('critical');
    expect(() => h.withReducerTx(ada, ctx => m.decide_response_proposal(ctx, { proposalId: id, adopt: false, note: '' }))).toThrow(/already adopted/);
  });

  it('refuses to adopt a plan once the incident state has changed underneath it', () => {
    const { h, ada, ben, incidentId } = setup();
    const fp = clientFingerprint(h, incidentId);
    h.withReducerTx(ben, ctx => m.propose_response(ctx, { incidentId, strategy: 'restore', targetAssetId: 'primary-db', rationale: '', stateFingerprint: fp }));
    const id = [...h.db.responseProposal.iter()][0]!.proposalId;
    // The real workflow moves on: recovery requested by Ada, approved by Ben → effect starts recovering.
    h.withReducerTx(ada, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }));
    const rid = [...h.db.recoveryAction.iter()][0]!.recoveryId;
    h.withReducerTx(ben, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }));
    expect(() => h.withReducerTx(ada, ctx => m.decide_response_proposal(ctx, { proposalId: id, adopt: true, note: '' }))).toThrow(/Stale proposal/);
    // Rejecting a stale plan is still allowed.
    h.withReducerTx(ada, ctx => m.decide_response_proposal(ctx, { proposalId: id, adopt: false, note: 'superseded' }));
    expect(h.db.responseProposal.proposalId.find(id)!.status).toBe('rejected');
  });

  it('only the proposer can withdraw, and reset withdraws pending plans', () => {
    const { h, ada, ben, incidentId } = setup();
    for (const strategy of ['restore', 'staged']) {
      const fp = clientFingerprint(h, incidentId);
      h.withReducerTx(ben, ctx => m.propose_response(ctx, { incidentId, strategy, targetAssetId: 'primary-db', rationale: '', stateFingerprint: fp }));
    }
    const [a, b] = [...h.db.responseProposal.iter()].map(p => p.proposalId);
    expect(() => h.withReducerTx(ada, ctx => m.withdraw_response_proposal(ctx, { proposalId: a! }))).toThrow(/Only the proposer/);
    h.withReducerTx(ben, ctx => m.withdraw_response_proposal(ctx, { proposalId: a! }));
    expect(h.db.responseProposal.proposalId.find(a!)!.status).toBe('withdrawn');
    h.withReducerTx(ada, ctx => m.reset_demo_environment(ctx, {}));
    expect(h.db.responseProposal.proposalId.find(b!)!.status).toBe('withdrawn');
  });
});

describe('decision explanations', () => {
  it('requires an authorized agent and rejects citations of evidence from other incidents', () => {
    const { h, ada, ben, agent, incidentId } = setup();
    h.withReducerTx(ben, ctx => m.request_decision_explanation(ctx, { incidentId, targetAssetId: 'primary-db' }));
    expect(() => h.withReducerTx(ben, ctx => m.request_decision_explanation(ctx, { incidentId, targetAssetId: 'primary-db' }))).toThrow(/already requested/);
    const xid = [...h.db.decisionExplanation.iter()][0]!.explanationId;
    expect(() => h.withReducerTx(ada, ctx => m.agent_claim_explanation(ctx, { explanationId: xid, model: 'nvidia/x' }))).toThrow(/not a registered ai_agent/);
    h.withReducerTx(agent, ctx => m.agent_claim_explanation(ctx, { explanationId: xid, model: 'nvidia/nemotron-test' }));
    const own = [...h.db.incidentEvidence.incidentId.filter(incidentId)].map(e => e.evidenceId);
    expect(own.length).toBeGreaterThan(0);
    expect(() => h.withReducerTx(agent, ctx => m.agent_complete_explanation(ctx, { explanationId: xid, text: 'Restore is safest [E999]', citedEvidence: [999n], failed: false }))).toThrow(/Cited evidence not found/);
    h.withReducerTx(agent, ctx => m.agent_complete_explanation(ctx, { explanationId: xid, text: 'Restore is the only executable option.', citedEvidence: [own[0]!], failed: false }));
    const x = h.db.decisionExplanation.explanationId.find(xid)!;
    expect(x.status).toBe('completed');
    expect(x.citedEvidence).toEqual([own[0]]);
  });

  it('can be cancelled when no agent is available (degraded mode)', () => {
    const { h, ben, incidentId } = setup();
    h.withReducerTx(ben, ctx => m.request_decision_explanation(ctx, { incidentId, targetAssetId: 'primary-db' }));
    const xid = [...h.db.decisionExplanation.iter()][0]!.explanationId;
    h.withReducerTx(ben, ctx => m.cancel_decision_explanation(ctx, { explanationId: xid }));
    expect(h.db.decisionExplanation.explanationId.find(xid)!.status).toBe('failed');
  });

  it('overload intensity ticks do not make a fresh proposal stale', () => {
    const { h, ada, ben } = setup();
    h.withReducerTx(ada, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'traffic_surge', title: '' }));
    const surge = [...h.db.incident.iter()].find(i => i.scenarioType === 'traffic_surge')!.incidentId;
    const fp = clientFingerprint(h, surge);
    tick(h, 2);
    h.withReducerTx(ben, ctx => m.propose_response(ctx, { incidentId: surge, strategy: 'staged', targetAssetId: 'ext-gateway', rationale: '', stateFingerprint: fp }));
    expect([...h.db.responseProposal.iter()].find(p => p.incidentId === surge)!.status).toBe('pending');
  });
});
