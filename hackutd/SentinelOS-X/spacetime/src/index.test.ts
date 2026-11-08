// Reducer tests executed against SpacetimeDB's in-process module test harness
// (a real datastore compiled to WASM), not mocks.
import { describe, expect, it } from 'vitest';
import { ConnectionId, ScheduleAt, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';

function auth(subject: string, conn: bigint) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub: subject }), new ConnectionId(conn));
}

function setup() {
  const h = createModuleTestHarness(spacetime, m);
  h.clock.set(new Timestamp(1_700_000_000_000_000n));
  const ic = auth('commander', 1n);
  const analyst = auth('analyst', 2n);
  const observer = auth('observer', 3n);
  h.withReducerTx(ic, ctx => m.init(ctx, {}));
  h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'Ada Commander' }));
  h.withReducerTx(analyst, ctx => {
    m.register_responder(ctx, { displayName: 'Ben Analyst' });
    m.dev_claim_role(ctx, { role: 'security_analyst' });
  });
  h.withReducerTx(observer, ctx => m.register_responder(ctx, { displayName: 'Oli Observer' }));
  return { h, ic, analyst, observer };
}

const launch = (h: ReturnType<typeof setup>['h'], who: TestAuth) =>
  h.withReducerTx(who, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'simulated_ransomware', title: '' }));

const tick = (h: ReturnType<typeof setup>['h'], n = 1) => {
  for (let i = 0; i < n; i++) h.withReducerTx(TestAuth.internal(), ctx => m.simulation_tick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(3_000_000n) } }));
};

const statusOf = (h: ReturnType<typeof setup>['h'], id: string) => {
  const a = h.db.asset.assetId.find(id)!;
  return `${a.operationalStatus}/${a.healthStatus}/${a.impactType}`;
};

describe('seeding and roles', () => {
  it('seeds synthetic infrastructure with dependencies on init', () => {
    const { h } = setup();
    const assets = [...h.db.asset.iter()];
    expect(assets.length).toBeGreaterThanOrEqual(8);
    expect(assets.every(a => a.healthStatus === 'healthy' && a.telemetrySource === 'synthetic')).toBe(true);
    expect([...h.db.dependency.iter()].length).toBeGreaterThan(8);
  });

  it('makes the first responder Incident Commander and later ones observers', () => {
    const { h, observer } = setup();
    const roles = [...h.db.responder.iter()].map(r => r.role).sort();
    expect(roles).toEqual(['incident_commander', 'observer', 'security_analyst']);
    expect(() => h.withReducerTx(observer, ctx => m.assign_role(ctx, { target: ctx.sender, role: 'incident_commander' }))).toThrow(
      /Unauthorized/
    );
  });
});

describe('simulated incident + dependency propagation', () => {
  it('creates an incident and propagates failure through the dependency graph', () => {
    const { h, analyst } = setup();
    launch(h, analyst);

    const incidents = [...h.db.incident.iter()];
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.status).toBe('open');
    expect(inc.isSimulation).toBe(true);
    expect(inc.severity).toBe('critical'); // mission-critical DB offline

    // direct
    expect(statusOf(h, 'primary-db')).toBe('offline/critical/direct');
    // single-level cascade
    expect(statusOf(h, 'auth-svc')).toBe('offline/offline/cascade');
    expect(statusOf(h, 'app-api')).toBe('offline/offline/cascade');
    // multi-level cascade
    expect(statusOf(h, 'customer-portal')).toBe('offline/offline/cascade');
    // independent components untouched
    for (const id of ['backup-svc', 'backup-vault', 'file-storage', 'ext-gateway', 'monitoring-svc']) {
      expect(statusOf(h, id)).toBe('online/healthy/none');
    }

    const affected = [...h.db.incidentAsset.incidentId.filter(inc.incidentId)];
    expect(affected.find(a => a.assetId === 'primary-db')?.impactType).toBe('direct');
    // Phase 2 topology: every service that requires the DB (directly or transitively) is impacted.
    expect(affected.filter(a => a.impactType === 'cascade').map(a => a.assetId).sort()).toEqual(['admin-portal', 'analytics-svc', 'app-api', 'auth-svc', 'customer-portal', 'payment-svc']);
    expect(affected.find(a => a.assetId === 'analytics-svc')?.impactStatus).toBe('degraded'); // noncritical edge
    expect(affected.find(a => a.assetId === 'customer-portal')?.depth).toBe(2);

    const types = [...h.db.incidentEvent.incidentId.filter(inc.incidentId)].map(e => e.eventType);
    expect(types).toContain('incident_created');
    expect(types).toContain('asset_failure_detected');
    expect(types).toContain('asset_marked_offline');
    expect(types).toContain('dependency_impact_calculated');
    expect(types).toContain('severity_updated');
    expect([...h.db.auditEvent.iter()].some(a => a.action === 'launch_simulated_incident')).toBe(true);
  });

  it('rejects duplicate simulations and unauthorized launches', () => {
    const { h, ic, observer } = setup();
    expect(() => launch(h, observer)).toThrow(/Unauthorized/);
    expect([...h.db.incident.iter()]).toHaveLength(0);
    launch(h, ic);
    expect(() => launch(h, ic)).toThrow(/already active/);
    expect([...h.db.incident.iter()]).toHaveLength(1);
  });

  it('rejects invalid input', () => {
    const { h, ic } = setup();
    expect(() =>
      h.withReducerTx(ic, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'real_attack', title: '' }))
    ).toThrow(/Unknown scenario/);
    expect(() =>
      h.withReducerTx(ic, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'simulated_ransomware', title: 'x\ny title' }))
    ).toThrow(/single line/);
    launch(h, ic);
    const id = [...h.db.incident.iter()][0]!.incidentId;
    expect(() => h.withReducerTx(ic, ctx => m.update_incident_status(ctx, { incidentId: id, status: 'bogus' }))).toThrow(/Invalid status/);
    expect(() => h.withReducerTx(ic, ctx => m.update_incident_status(ctx, { incidentId: id, status: 'resolved' }))).toThrow(
      /resolve_incident/
    );
    expect(() =>
      h.withReducerTx(ic, ctx => m.update_asset_status(ctx, { assetId: '../etc', failure: 'offline', incidentId: id, reason: 'test' }))
    ).toThrow(/Invalid asset id/);
    expect(() => h.withReducerTx(ic, ctx => m.update_incident_status(ctx, { incidentId: 999n, status: 'contained' }))).toThrow(/not found/);
  });

  it('injected noncritical failure degrades dependents without taking them down', () => {
    const { h, ic } = setup();
    launch(h, ic);
    const id = [...h.db.incident.iter()][0]!.incidentId;
    h.withReducerTx(ic, ctx => m.update_asset_status(ctx, { assetId: 'telemetry-gw', failure: 'offline', incidentId: id, reason: 'lab test' }));
    expect(statusOf(h, 'monitoring-svc')).toBe('offline/offline/cascade');
    expect(statusOf(h, 'log-shipper')).toBe('degraded/degraded/cascade');
    expect(statusOf(h, 'backup-svc')).toBe('online/healthy/none'); // optional edge
  });
});

describe('incident lifecycle', () => {
  it('updates status, records events, tasks, decisions and messages', () => {
    const { h, ic, analyst, observer } = setup();
    launch(h, ic);
    const id = [...h.db.incident.iter()][0]!.incidentId;

    h.withReducerTx(analyst, ctx => m.update_incident_status(ctx, { incidentId: id, status: 'investigating' }));
    expect(h.db.incident.incidentId.find(id)?.status).toBe('investigating');
    expect(() => h.withReducerTx(analyst, ctx => m.update_incident_status(ctx, { incidentId: id, status: 'open' }))).toThrow(
      /Invalid incident status transition/
    );

    h.withReducerTx(analyst, ctx =>
      m.record_incident_event(ctx, { incidentId: id, description: 'Isolated DB subnet', metadata: [{ key: 'vlan', value: '40' }] })
    );
    const note = [...h.db.incidentEvent.incidentId.filter(id)].find(e => e.eventType === 'note_added')!;
    expect(note.metadata).toEqual([{ key: 'vlan', value: '40' }]);
    expect(note.actorName).toBe('Ben Analyst');

    h.withReducerTx(ic, ctx => m.create_response_task(ctx, { incidentId: id, title: 'Verify backup integrity', assignee: undefined }));
    const task = [...h.db.responseTask.iter()][0]!;
    h.withReducerTx(analyst, ctx => m.update_response_task(ctx, { taskId: task.taskId, status: 'in_progress' }));
    expect(h.db.responseTask.taskId.find(task.taskId)?.status).toBe('in_progress');
    expect(() => h.withReducerTx(observer, ctx => m.update_response_task(ctx, { taskId: task.taskId, status: 'done' }))).toThrow(
      /Unauthorized/
    );

    h.withReducerTx(ic, ctx => m.record_incident_decision(ctx, { incidentId: id, summary: 'Do not pay ransom', rationale: 'Clean backups exist' }));
    expect([...h.db.incidentDecision.iter()]).toHaveLength(1);
    expect(() =>
      h.withReducerTx(analyst, ctx => m.record_incident_decision(ctx, { incidentId: id, summary: 'x y z', rationale: 'abc' }))
    ).toThrow(/Unauthorized/);

    h.withReducerTx(analyst, ctx => m.send_incident_message(ctx, { incidentId: id, body: 'DB host isolated' }));
    expect(() => h.withReducerTx(observer, ctx => m.send_incident_message(ctx, { incidentId: id, body: 'hi' }))).toThrow(/Unauthorized/);
    expect(() => h.withReducerTx(analyst, ctx => m.send_incident_message(ctx, { incidentId: id, body: '   ' }))).toThrow(/at least/);
    expect([...h.db.incidentMessage.iter()]).toHaveLength(1);
  });

  it('lets any registered responder (even an observer) change status and resolve tickets', () => {
    const { h, ic, observer } = setup();
    launch(h, ic);
    const id = [...h.db.incident.iter()][0]!.incidentId;
    h.withReducerTx(observer, ctx => m.update_incident_status(ctx, { incidentId: id, status: 'investigating' }));
    expect(h.db.incident.incidentId.find(id)?.status).toBe('investigating');
    // Resolution is still gated on recovery state, not on role.
    expect(() => h.withReducerTx(observer, ctx => m.resolve_incident(ctx, { incidentId: id, summary: 'premature' }))).toThrow(/not yet recovered/);
    h.withReducerTx(observer, ctx => m.request_recovery(ctx, { incidentId: id, assetId: 'primary-db', plan: 'Restore from offsite vault snapshot' }));
    const rec = [...h.db.recoveryAction.iter()][0]!;
    h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rec.recoveryId, approve: true, note: '' }));
    expect([...h.db.recoveryAction.iter()][0]!.status).toBe('approved');
  });

  it('requires two-person approved recovery before resolution, then restores the twin', () => {
    const { h, ic, analyst } = setup();
    launch(h, analyst);
    const id = [...h.db.incident.iter()][0]!.incidentId;

    expect(() => h.withReducerTx(ic, ctx => m.resolve_incident(ctx, { incidentId: id, summary: 'all good' }))).toThrow(/not yet recovered/);

    h.withReducerTx(ic, ctx => m.request_recovery(ctx, { incidentId: id, assetId: 'primary-db', plan: 'Restore from offsite vault snapshot' }));
    const rec = [...h.db.recoveryAction.iter()][0]!;
    expect(() => h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rec.recoveryId, approve: true, note: '' }))).toThrow(
      /Two-person rule/
    );

    // Any other responder (no role requirement) can approve.
    h.withReducerTx(analyst, ctx => m.decide_recovery(ctx, { recoveryId: rec.recoveryId, approve: true, note: 'Snapshot verified' }));

    // Approval starts a simulated restoration: Recovering first, healthy after the engine ticks.
    expect(h.db.asset.assetId.find('primary-db')?.healthStatus).toBe('recovering');
    expect(h.db.asset.assetId.find('auth-svc')?.healthStatus).toBe('recovering');
    tick(h, 2);
    for (const a of h.db.asset.iter()) expect(a.healthStatus).toBe('healthy');
    const affected = [...h.db.incidentAsset.incidentId.filter(id)];
    expect(affected.every(a => a.impactStatus === 'recovered')).toBe(true);
    expect([...h.db.incidentEvent.incidentId.filter(id)].some(e => e.eventType === 'asset_restored')).toBe(true);

    h.withReducerTx(ic, ctx => m.resolve_incident(ctx, { incidentId: id, summary: 'Restored from backups' }));
    const inc = h.db.incident.incidentId.find(id)!;
    expect(inc.status).toBe('resolved');
    expect(inc.resolvedAt).toBeDefined();
    expect(() => h.withReducerTx(ic, ctx => m.send_incident_message(ctx, { incidentId: id, body: 'late' }))).toThrow(/resolved/);

    // A new simulation is allowed after resolution.
    launch(h, ic);
    expect([...h.db.incident.iter()]).toHaveLength(2);
  });

  it('reset restores assets and closes simulations without deleting records', () => {
    const { h, ic, analyst } = setup();
    launch(h, ic);
    const before = [...h.db.incidentEvent.iter()].length;
    expect(() => h.withReducerTx(analyst, ctx => m.reset_demo_environment(ctx, {}))).toThrow(/Unauthorized/);
    h.withReducerTx(ic, ctx => m.reset_demo_environment(ctx, {}));
    for (const a of h.db.asset.iter()) expect(a.healthStatus).toBe('healthy');
    expect([...h.db.incident.iter()][0]?.status).toBe('resolved');
    expect([...h.db.incidentEvent.iter()].length).toBeGreaterThan(before);
  });
});
