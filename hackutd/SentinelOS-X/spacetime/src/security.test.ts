// Authorization regression tests on the real WASM datastore: every check here is
// enforced by reducers, not by the UI.
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';

const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub }), new ConnectionId(c));

function setup() {
  const h = createModuleTestHarness(spacetime, m);
  h.clock.set(new Timestamp(1_700_000_000_000_000n));
  const ic = auth('ic', 1n);
  const analyst = auth('analyst', 2n);
  const observer = auth('observer', 3n);
  const stranger = auth('stranger', 4n);
  const agent = auth('agent', 5n);
  const gateway = auth('gateway', 6n);
  h.withReducerTx(ic, ctx => m.init(ctx, {}));
  h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'IC' }));
  h.withReducerTx(analyst, ctx => {
    m.register_responder(ctx, { displayName: 'Analyst' });
    m.dev_claim_role(ctx, { role: 'security_analyst' });
  });
  h.withReducerTx(observer, ctx => m.register_responder(ctx, { displayName: 'Observer' }));
  h.withReducerTx(agent, ctx => m.announce_service(ctx, { name: 'Nemotron Investigator', kind: 'ai_agent' }));
  h.withReducerTx(gateway, ctx => m.announce_service(ctx, { name: 'Sentinel Gateway', kind: 'hardware_gateway' }));
  h.withReducerTx(analyst, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'database_outage', title: '' }));
  const incidentId = [...h.db.incident.iter()][0]!.incidentId;
  const svc = (kind: string) => [...h.db.servicePrincipal.iter()].find(s => s.kind === kind)!.identity;
  return { h, ic, analyst, observer, stranger, agent, gateway, incidentId, svc };
}

describe('two-person recovery', () => {
  it('rejects self-approval and duplicate decisions', () => {
    const { h, ic, analyst, observer, incidentId } = setup();
    h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }));
    const rid = [...h.db.recoveryAction.iter()][0]!.recoveryId;
    expect(() => h.withReducerTx(analyst, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }))).toThrow(/Two-person rule/);
    h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }));
    expect(() => h.withReducerTx(observer, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }))).toThrow();
    expect(() => h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: false, note: '' }))).toThrow();
    expect([...h.db.recoveryAction.iter()].filter(r => r.status === 'approved')).toHaveLength(1);
  });

  it('rejects a second pending recovery for the same asset', () => {
    const { h, analyst, incidentId } = setup();
    h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }));
    expect(() => h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore again please' }))).toThrow();
  });

  it('unregistered identities cannot request or approve anything', () => {
    const { h, analyst, stranger, incidentId } = setup();
    expect(() => h.withReducerTx(stranger, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }))).toThrow(/register|Unauthorized/i);
    h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }));
    const rid = [...h.db.recoveryAction.iter()][0]!.recoveryId;
    expect(() => h.withReducerTx(stranger, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }))).toThrow(/register|Unauthorized/i);
  });
});

describe('roles cannot be forged from the client', () => {
  it('only an Incident Commander can assign roles or toggle self-service', () => {
    const { h, analyst, observer } = setup();
    const observerId = [...h.db.responder.iter()].find(r => r.displayName === 'Observer')!.identity;
    expect(() => h.withReducerTx(analyst, ctx => m.assign_role(ctx, { target: observerId, role: 'incident_commander' }))).toThrow(/Unauthorized/);
    expect(() => h.withReducerTx(observer, ctx => m.set_dev_role_self_service(ctx, { enabled: true }))).toThrow(/Unauthorized/);
  });

  it('with self-service disabled, nobody can promote themselves', () => {
    const { h, ic, observer } = setup();
    h.withReducerTx(ic, ctx => m.set_dev_role_self_service(ctx, { enabled: false }));
    expect(() => h.withReducerTx(observer, ctx => m.dev_claim_role(ctx, { role: 'incident_commander' }))).toThrow();
    expect([...h.db.responder.iter()].find(r => r.displayName === 'Observer')!.role).toBe('observer');
  });
});

describe('service identities', () => {
  it('the AI agent cannot act as a human or approve anything', () => {
    const { h, ic, agent, analyst, incidentId, svc } = setup();
    const agentId = svc('ai_agent');
    h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: agentId, authorize: true }));
    expect(() => h.withReducerTx(agent, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }))).toThrow();
    h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId, assetId: 'primary-db', plan: 'Restore from snapshot' }));
    const rid = [...h.db.recoveryAction.iter()][0]!.recoveryId;
    expect(() => h.withReducerTx(agent, ctx => m.decide_recovery(ctx, { recoveryId: rid, approve: true, note: '' }))).toThrow();
    expect(() => h.withReducerTx(agent, ctx => m.apply_containment(ctx, { incidentId, assetId: 'primary-db' }))).toThrow();
    expect(() => h.withReducerTx(agent, ctx => m.register_responder(ctx, { displayName: 'Totally Human' }))).toThrow();
  });

  it('an unauthorized gateway, or a human, cannot submit sensor readings', () => {
    const { h, ic, gateway, analyst, svc } = setup();
    expect(() => h.withReducerTx(gateway, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC: 40, humidityPct: 90 }))).toThrow();
    expect(() => h.withReducerTx(analyst, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC: 40, humidityPct: 90 }))).toThrow();
    expect([...h.db.sensorReading.iter()]).toHaveLength(0);
    const gwId = svc('hardware_gateway');
    h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: gwId, authorize: true }));
    h.withReducerTx(gateway, ctx => m.register_sensor_node(ctx, { nodeId: 'uno-r4-01', name: 'Closet sensor', tempLimitC: 30, humidityLimitPct: 70 }));
    h.withReducerTx(gateway, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC: 23, humidityPct: 41 }));
    expect([...h.db.sensorReading.iter()]).toHaveLength(1);
  });

  it('the agent cannot record findings for an investigation it has not claimed', () => {
    const { h, ic, agent, analyst, incidentId, svc } = setup();
    const agentId = svc('ai_agent');
    h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: agentId, authorize: true }));
    h.withReducerTx(analyst, ctx => m.request_ai_investigation(ctx, { incidentId }));
    const inv = [...h.db.aiInvestigation.iter()][0]!.investigationId;
    expect(() =>
      h.withReducerTx(agent, ctx => m.agent_record_finding(ctx, { investigationId: inv, kind: 'finding', summary: 'x'.repeat(20), evidence: 'get_incident', assetId: undefined, confidence: 'high' }))
    ).toThrow();
  });
});
