// Phase 2 scenarios, containment, recovery, overlap, seeding and engine bounds,
// executed against SpacetimeDB's module test harness (real datastore in WASM).
import { describe, expect, it } from 'vitest';
import { ConnectionId, ScheduleAt, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';
import { DEMO_ASSETS as SEED_ASSETS, DEMO_EDGES as SEED_EDGES } from './seed';

const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub }), new ConnectionId(c));

function setup() {
  const h = createModuleTestHarness(spacetime, m);
  let now = 1_700_000_000_000_000n;
  h.clock.set(new Timestamp(now));
  const ic = auth('ic', 1n), ic2 = auth('ic2', 2n), an = auth('an', 3n), obs = auth('obs', 4n);
  h.withReducerTx(ic, ctx => m.init(ctx, {}));
  h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'Ada' }));
  h.withReducerTx(ic2, ctx => { m.register_responder(ctx, { displayName: 'Cy' }); m.dev_claim_role(ctx, { role: 'incident_commander' }); });
  h.withReducerTx(an, ctx => { m.register_responder(ctx, { displayName: 'Ben' }); m.dev_claim_role(ctx, { role: 'security_analyst' }); });
  h.withReducerTx(obs, ctx => m.register_responder(ctx, { displayName: 'Oli' }));
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 3_000_000n;
      h.clock.set(new Timestamp(now));
      h.withReducerTx(TestAuth.internal(), ctx => m.simulation_tick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(3_000_000n) } }));
    }
  };
  const launch = (scenarioType: string, who = an) => {
    h.withReducerTx(who, ctx => m.launch_simulated_incident(ctx, { scenarioType, title: '' }));
    return [...h.db.incident.iter()].find(i => i.scenarioType === scenarioType && i.status !== 'resolved')!.incidentId;
  };
  const health = (id: string) => h.db.asset.assetId.find(id)!.healthStatus;
  const events = (incidentId: bigint) => [...h.db.incidentEvent.incidentId.filter(incidentId)].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  /** Request (analyst) → approve (IC) → let the engine finish the restoration. */
  const recover = (incidentId: bigint, assetId: string) => {
    h.withReducerTx(an, ctx => m.request_recovery(ctx, { incidentId, assetId, plan: 'Simulated restoration plan' }));
    const rec = [...h.db.recoveryAction.incidentId.filter(incidentId)].find(r => r.assetId === assetId && r.status === 'pending')!;
    h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rec.recoveryId, approve: true, note: 'verified' }));
  };
  return { h, ic, ic2, an, obs, tick, launch, health, events, recover };
}

describe('seed environment', () => {
  it('seeds 16 services with stable ids and is idempotent, even with an active incident', () => {
    const { h, ic, launch, health } = setup();
    expect([...h.db.asset.iter()]).toHaveLength(SEED_ASSETS.length);
    expect(SEED_ASSETS.length).toBeGreaterThanOrEqual(12);
    expect([...h.db.dependency.iter()]).toHaveLength(SEED_EDGES.length);
    const id = launch('database_outage');
    const before = { inc: [...h.db.incident.iter()].length, eff: [...h.db.incidentEffect.iter()].length, db: health('primary-db') };
    h.withReducerTx(ic, ctx => m.seed_demo_infrastructure(ctx, {}));
    h.withReducerTx(ic, ctx => m.seed_demo_infrastructure(ctx, {}));
    expect([...h.db.asset.iter()]).toHaveLength(SEED_ASSETS.length);
    expect([...h.db.dependency.iter()]).toHaveLength(SEED_EDGES.length);
    expect([...h.db.incident.iter()]).toHaveLength(before.inc);
    expect([...h.db.incidentEffect.iter()]).toHaveLength(before.eff);
    expect(health('primary-db')).toBe(before.db);
    expect(h.db.incident.incidentId.find(id)?.status).toBe('open');
  });

  it('restores only missing services and converts Phase 1 asset-row faults into effects', () => {
    const { h, ic, health } = setup();
    // Simulate a Phase 1 database: a missing new service and a legacy fault stored on the asset row.
    h.withReducerTx(TestAuth.internal(), ctx => {
      ctx.db.asset.assetId.delete('payment-svc');
      const inc = ctx.db.incident.insert({ incidentId: 0n, title: 'Legacy incident', description: 'Phase 1', severity: 'critical', status: 'open', scenarioType: 'simulated_ransomware', initialAssetId: 'primary-db', isSimulation: true, createdBy: ctx.sender, createdAt: ctx.timestamp, updatedAt: ctx.timestamp, resolvedAt: undefined, resolutionSummary: undefined });
      const db = ctx.db.asset.assetId.find('primary-db')!;
      ctx.db.asset.assetId.update({ ...db, directFailure: 'offline', directIncidentId: inc.incidentId });
    });
    h.withReducerTx(ic, ctx => m.onConnect(ctx, {}));
    expect(h.db.asset.assetId.find('payment-svc')).not.toBeNull();
    const eff = [...h.db.incidentEffect.iter()];
    expect(eff).toHaveLength(1);
    expect(eff[0]).toMatchObject({ assetId: 'primary-db', kind: 'outage', phase: 'active' });
    expect(health('primary-db')).toBe('critical');
    expect(health('auth-svc')).toBe('offline');
    h.withReducerTx(ic, ctx => m.onConnect(ctx, {})); // second connect: nothing new
    expect([...h.db.incidentEffect.iter()]).toHaveLength(1);
  });
});

describe('Scenario A — authentication compromise', () => {
  it('confirms the root, flags dependents as potentially exposed, and recovers after containment', () => {
    const { h, an, ic, launch, health, events, tick, recover } = setup();
    const id = launch('auth_compromise');
    const inc = h.db.incident.incidentId.find(id)!;
    expect(inc).toMatchObject({ initialAssetId: 'auth-svc', severity: 'critical', status: 'open', isSimulation: true });
    expect(health('auth-svc')).toBe('critical');
    for (const dep of ['app-api', 'payment-svc', 'admin-portal', 'customer-portal']) {
      expect(health(dep)).toBe('healthy');
      expect(h.db.asset.assetId.find(dep)?.impactType).toBe('exposed');
    }
    const ev = [...h.db.incidentEvidence.incidentId.filter(id)];
    expect(ev.length).toBeGreaterThanOrEqual(4);
    expect(ev.every(e => e.synthetic && e.kind === 'auth_log')).toBe(true);
    const types = events(id).map(e => e.eventType);
    expect(types.slice(0, 3)).toEqual(['incident_created', 'evidence_collected', 'asset_failure_detected']);
    expect(types).toContain('asset_exposed');
    expect(types).toContain('dependency_impact_calculated');

    expect(() => h.withReducerTx(an, ctx => m.request_recovery(ctx, { incidentId: id, assetId: 'auth-svc', plan: 'rotate keys' }))).toThrow(/Contain Authentication Service first/);
    h.withReducerTx(an, ctx => m.apply_containment(ctx, { incidentId: id, assetId: 'auth-svc' }));
    expect(h.db.incident.incidentId.find(id)?.status).toBe('contained');
    expect(h.db.asset.assetId.find('app-api')?.impactType).toBe('none'); // exposure stops once sessions are revoked
    expect(() => h.withReducerTx(an, ctx => m.apply_containment(ctx, { incidentId: id, assetId: 'auth-svc' }))).toThrow(/already contained/);

    recover(id, 'auth-svc');
    expect(h.db.incident.incidentId.find(id)?.status).toBe('recovering');
    expect(health('auth-svc')).toBe('recovering');
    tick(2);
    expect(health('auth-svc')).toBe('healthy');
    h.withReducerTx(ic, ctx => m.resolve_incident(ctx, { incidentId: id, summary: 'Keys rotated, sessions revoked' }));
    expect(h.db.incident.incidentId.find(id)?.status).toBe('resolved');
  });
});

describe('Scenario B — database outage', () => {
  it('takes the dependency chain down and recovers directly (no containment step)', () => {
    const { h, an, launch, health, tick, recover } = setup();
    const id = launch('database_outage');
    expect(h.db.incident.incidentId.find(id)?.severity).toBe('critical');
    expect(health('primary-db')).toBe('critical');
    expect(['auth-svc', 'app-api', 'payment-svc', 'customer-portal', 'admin-portal'].map(health)).toEqual(Array(5).fill('offline'));
    expect(health('analytics-svc')).toBe('degraded');
    expect(health('backup-vault')).toBe('healthy');
    expect(() => h.withReducerTx(an, ctx => m.apply_containment(ctx, { incidentId: id, assetId: 'primary-db' }))).toThrow(/No containment applies/);
    recover(id, 'primary-db');
    tick(2);
    expect([...h.db.asset.iter()].every(a => a.healthStatus === 'healthy')).toBe(true);
    expect([...h.db.incidentAsset.incidentId.filter(id)].every(r => r.impactStatus === 'recovered')).toBe(true);
  });
});

describe('Scenario C — traffic surge', () => {
  it('degrades without exposure, escalates to saturation, and is mitigated by rate limiting', () => {
    const { h, an, launch, health, events, tick, recover } = setup();
    const id = launch('traffic_surge');
    expect(health('ext-gateway')).toBe('degraded');
    expect(health('customer-portal')).toBe('degraded');
    expect([...h.db.asset.iter()].some(a => a.impactType === 'exposed')).toBe(false);
    expect(h.db.incident.incidentId.find(id)?.severity).toBe('medium');
    tick(3); // intensity 0.4 → 1.0
    expect(health('ext-gateway')).toBe('critical');
    expect(h.db.incident.incidentId.find(id)?.severity).toBe('high');
    expect(events(id).map(e => e.eventType)).toContain('surge_escalated');
    const gw = [...h.db.telemetryMetric.assetId.filter('ext-gateway')].sort((a, b) => (a.metricId < b.metricId ? -1 : 1));
    expect(gw[gw.length - 1]!.requestRpm).toBeGreaterThan(9000 * 8); // far above baseline
    h.withReducerTx(an, ctx => m.apply_containment(ctx, { incidentId: id, assetId: 'ext-gateway' }));
    expect(health('ext-gateway')).toBe('degraded');
    recover(id, 'ext-gateway');
    tick(2);
    expect(health('ext-gateway')).toBe('healthy');
    expect(health('customer-portal')).toBe('healthy');
  });
});

describe('Scenario D — ransomware-like file service incident', () => {
  it('isolation trades exposure for an offline file service, then restores', () => {
    const { h, an, launch, health, tick, recover } = setup();
    const id = launch('file_ransomware');
    expect(health('file-storage')).toBe('critical');
    expect(h.db.asset.assetId.find('file-storage')?.operationalStatus).toBe('degraded');
    expect(health('app-api')).toBe('degraded');
    expect([...h.db.incidentEvidence.incidentId.filter(id)].some(e => e.kind === 'file_integrity' && e.title === 'Mass file renames')).toBe(true);
    h.withReducerTx(an, ctx => m.apply_containment(ctx, { incidentId: id, assetId: 'file-storage' }));
    expect(h.db.asset.assetId.find('file-storage')?.operationalStatus).toBe('offline');
    expect([...h.db.asset.iter()].some(a => a.impactType === 'exposed')).toBe(false);
    recover(id, 'file-storage');
    tick(2);
    expect([...h.db.asset.iter()].every(a => a.healthStatus === 'healthy')).toBe(true);
  });
});

describe('overlapping incidents', () => {
  it('recovering one incident never marks a shared service healthy while another is active', () => {
    const { h, launch, health, tick, recover, events } = setup();
    const a = launch('database_outage');
    const b = launch('simulated_ransomware'); // Phase 1 scenario on the same database
    expect(health('primary-db')).toBe('critical');
    recover(a, 'primary-db');
    tick(2);
    expect(health('primary-db')).toBe('critical'); // incident b still holds it down
    expect(health('auth-svc')).toBe('offline');
    expect([...h.db.incidentAsset.incidentId.filter(a)].every(r => r.impactStatus === 'recovered')).toBe(true);
    expect(events(a).some(e => e.eventType === 'asset_restored' && /still impacted by another incident/.test(e.description))).toBe(true);
    recover(b, 'primary-db');
    tick(2);
    expect(health('primary-db')).toBe('healthy');
  });
});

describe('state machine, permissions and bounds', () => {
  it('rejects invalid transitions and unauthorized actions server-side', () => {
    const { h, obs, an, ic, launch } = setup();
    expect(() => h.withReducerTx(obs, ctx => m.launch_simulated_incident(ctx, { scenarioType: 'auth_compromise', title: '' }))).toThrow(/Unauthorized/);
    const id = launch('auth_compromise');
    expect(() => launch('auth_compromise')).toThrow(/already active/);
    expect(() => h.withReducerTx(an, ctx => m.update_incident_status(ctx, { incidentId: id, status: 'recovering' }))).toThrow(/Invalid incident status transition open -> recovering/);
    expect(() => h.withReducerTx(an, ctx => m.set_simulation_engine(ctx, { telemetryEnabled: false }))).toThrow(/Unauthorized/);
    expect(() => h.withReducerTx(ic, ctx => m.simulation_tick(ctx, { timer: { scheduledId: 1n, scheduledAt: ScheduleAt.interval(3_000_000n) } }))).toThrow(/scheduler/);
    expect(() => h.withReducerTx(ic, ctx => m.resolve_incident(ctx, { incidentId: id, summary: 'premature' }))).toThrow(/not yet recovered/);
  });

  it('keeps telemetry, evidence and the timeline bounded and free of duplicate events', () => {
    const { h, launch, tick, events } = setup();
    const id = launch('traffic_surge');
    tick(60);
    for (const a of SEED_ASSETS) {
      expect([...h.db.telemetryMetric.assetId.filter(a.assetId)].length).toBeLessThanOrEqual(40);
      expect([...h.db.telemetrySample.assetId.filter(a.assetId)].length).toBeLessThanOrEqual(30);
    }
    expect([...h.db.incidentEvidence.incidentId.filter(id)].length).toBeLessThanOrEqual(24);
    expect(h.db.simulationState.stateId.find(0)?.tickCount).toBe(60n);
    const ev = events(id);
    expect(new Set(ev.map(e => e.eventId)).size).toBe(ev.length);
    // After saturation nothing structural changes, so 50+ further ticks add no impact events.
    const impactEvents = ev.filter(e => e.eventType.startsWith('asset_') || e.eventType === 'dependency_impact_calculated');
    const keys = impactEvents.map(e => `${e.eventType}|${e.assetId}|${e.metadata.find(x => x.key === 'new_status')?.value}`);
    expect(new Set(keys).size).toBe(keys.length);
    const metrics = [...h.db.telemetryMetric.iter()];
    expect(metrics.every(x => x.source === 'simulation_engine' && x.memoryPct >= 0 && x.connections >= 0 && x.errorRate <= 1)).toBe(true);
  });

  it('stops generating telemetry when the engine is disabled but still completes recoveries', () => {
    const { h, ic, launch, tick, recover, health } = setup();
    h.withReducerTx(ic, ctx => m.set_simulation_engine(ctx, { telemetryEnabled: false }));
    const id = launch('database_outage');
    recover(id, 'primary-db');
    tick(2);
    expect([...h.db.telemetryMetric.iter()]).toHaveLength(0);
    expect(health('primary-db')).toBe('healthy');
  });
});
