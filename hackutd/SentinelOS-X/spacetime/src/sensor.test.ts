// Physical sensor gateway: pure detection + reducers on SpacetimeDB's module test harness.
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetime, * as m from './index';
import * as sensor from './sensor';

const LIM = { tempLimitC: 30, humidityLimitPct: 70 };
const r = (tempC: number, humidityPct: number, atMs: number): sensor.Reading => ({ tempC, humidityPct, atMs });

describe('detectBreaches (pure)', () => {
  it('is quiet for normal readings', () => {
    const h = [r(23.5, 41, 0), r(23.6, 41, 2000), r(23.5, 42, 4000)];
    expect(sensor.detectBreaches(h, LIM)).toEqual([]);
  });
  it('flags temperature and humidity at or above their limits', () => {
    const b = sensor.detectBreaches([r(23, 40, 0), r(30, 75, 2000)], LIM);
    expect(b.map(x => x.kind).sort()).toEqual(['humidity_high', 'temperature_high']);
  });
  it('flags a rapid rise even below the absolute limit', () => {
    const h = [r(23, 40, 0), r(23.2, 40, 10_000), r(23.1, 40, 20_000), r(27, 40, 30_000)];
    expect(sensor.detectBreaches(h, LIM).map(x => x.kind)).toEqual(['temperature_rise']);
  });
  it('ignores old readings outside the rise window and needs enough readings', () => {
    expect(sensor.detectBreaches([r(20, 40, 0), r(27, 40, 500_000)], LIM)).toEqual([]);
    expect(sensor.detectBreaches([r(20, 40, 0), r(27, 40, 1000)], LIM)).toEqual([]);
  });
  it('baseline is unknown, not zero, when there is too little history', () => {
    expect(sensor.baselineTempC([r(23, 40, 0), r(24, 40, 1000)])).toBeNull();
    const ev = sensor.buildEvidence('n1', 'DHT11', [{ kind: 'temperature_high', value: 31, limit: 30 }], [r(23, 40, 0), r(31, 40, 2000)]);
    expect(ev[0]!.indicators.find(i => i.key === 'baseline_c')!.value).toBe('unknown');
  });
  it('rejects physically impossible readings', () => {
    expect(sensor.validateReading(Number.NaN, 40)).toMatch(/tempC/);
    expect(sensor.validateReading(23, 120)).toMatch(/humidityPct/);
    expect(sensor.validateReading(23, 40)).toBeNull();
  });
});

const auth = (sub: string, c: bigint) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'sentinelos-test', sub }), new ConnectionId(c));

function setup() {
  const h = createModuleTestHarness(spacetime, m);
  let now = 1_700_000_000_000_000n;
  h.clock.set(new Timestamp(now));
  const tick = (sec = 2) => {
    now += BigInt(sec) * 1_000_000n;
    h.clock.set(new Timestamp(now));
  };
  const ic = auth('ic', 1n), analyst = auth('an', 3n), gw = auth('gw', 4n), agent = auth('agent', 5n), rogue = auth('rogue', 6n);
  h.withReducerTx(ic, ctx => m.init(ctx, {}));
  h.withReducerTx(ic, ctx => m.register_responder(ctx, { displayName: 'Ada' }));
  h.withReducerTx(analyst, ctx => { m.register_responder(ctx, { displayName: 'Ben' }); m.dev_claim_role(ctx, { role: 'security_analyst' }); });
  let gwId: Identity | undefined;
  h.withReducerTx(gw, ctx => { gwId = ctx.sender; m.announce_service(ctx, { name: 'Sentinel Gateway', kind: 'hardware_gateway' }); });
  h.withReducerTx(agent, ctx => m.announce_service(ctx, { name: 'Nemotron Investigator', kind: 'ai_agent' }));
  h.withReducerTx(ic, ctx => m.authorize_service(ctx, { target: gwId!, authorize: true }));
  const reg = () => h.withReducerTx(gw, ctx => m.register_sensor_node(ctx, { nodeId: 'uno-r4-01', name: 'Server closet', tempLimitC: 30, humidityLimitPct: 70 }));
  const read = (tempC: number, humidityPct: number) => { tick(); h.withReducerTx(gw, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC, humidityPct })); };
  return { h, ic, analyst, gw, rogue, reg, read, tick };
}

describe('gateway authorization', () => {
  it('requires an authorized hardware_gateway service', () => {
    const { h, analyst, rogue, reg } = setup();
    reg();
    expect(() => h.withReducerTx(analyst, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC: 24, humidityPct: 40 }))).toThrow(/not a registered hardware_gateway/);
    expect(() => h.withReducerTx(rogue, ctx => m.register_sensor_node(ctx, { nodeId: 'x1', name: 'Rogue node', tempLimitC: 30, humidityLimitPct: 70 }))).toThrow(/not a registered hardware_gateway/);
  });
  it('rejects an unauthorized (pending) gateway', () => {
    const { h } = setup();
    const gw2 = auth('gw2', 9n);
    h.withReducerTx(gw2, ctx => m.announce_service(ctx, { name: 'Other gateway', kind: 'hardware_gateway' }));
    expect(() => h.withReducerTx(gw2, ctx => m.register_sensor_node(ctx, { nodeId: 'x2', name: 'Other node', tempLimitC: 30, humidityLimitPct: 70 }))).toThrow(/pending/);
  });
  it('rejects unregistered nodes, bad readings and bad limits', () => {
    const { h, gw, reg } = setup();
    expect(() => h.withReducerTx(gw, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC: 24, humidityPct: 40 }))).toThrow(/not registered/);
    reg();
    expect(() => h.withReducerTx(gw, ctx => m.ingest_sensor_reading(ctx, { nodeId: 'uno-r4-01', tempC: 500, humidityPct: 40 }))).toThrow(/tempC/);
    expect(() => h.withReducerTx(gw, ctx => m.register_sensor_node(ctx, { nodeId: 'x3', name: 'Bad limits', tempLimitC: 30, humidityLimitPct: 0 }))).toThrow(/humidityLimitPct/);
  });
});

describe('registration', () => {
  it('creates a physical asset marked as real hardware and a modeled dependency, idempotently', () => {
    const { h, reg } = setup();
    reg();
    reg();
    const a = h.db.asset.assetId.find('env-uno-r4-01')!;
    expect(a.telemetrySource).toBe('physical_sensor');
    expect(a.assetType).toBe('environment_sensor');
    const edges = [...h.db.dependency.dependentAssetId.filter('primary-db')].filter(d => d.requiredAssetId === 'env-uno-r4-01');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rationale).toMatch(/MODELED/);
    expect([...h.db.sensorNode.iter()]).toHaveLength(1);
  });
});

describe('real environmental incident', () => {
  it('stays quiet for normal readings and stores a bounded window', () => {
    const { h, reg, read } = setup();
    reg();
    for (let i = 0; i < 620; i++) read(23.5, 41);
    expect([...h.db.incident.iter()]).toHaveLength(0);
    expect([...h.db.sensorReading.nodeId.filter('uno-r4-01')]).toHaveLength(600);
  });

  it('debounces a single glitch, then opens ONE real incident with measured evidence and an AI request', () => {
    const { h, reg, read } = setup();
    reg();
    for (let i = 0; i < 8; i++) read(23.5, 41);
    read(35, 41); // single spike
    read(23.5, 41); // back to normal
    expect([...h.db.incident.iter()]).toHaveLength(0);

    read(31, 41);
    read(32, 41); // second consecutive breach opens the incident
    read(33, 41); // still breaching: must not open another
    const incs = [...h.db.incident.iter()];
    expect(incs).toHaveLength(1);
    const inc = incs[0]!;
    expect(inc.isSimulation).toBe(false);
    expect(inc.scenarioType).toBe('environmental_excursion');
    expect(inc.initialAssetId).toBe('env-uno-r4-01');
    expect(inc.title).toMatch(/Environmental excursion/);

    const ev = [...h.db.incidentEvidence.incidentId.filter(inc.incidentId)];
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(ev.every(e => e.synthetic === false)).toBe(true);
    expect(ev.every(e => e.kind === 'environment')).toBe(true);

    const inv = [...h.db.aiInvestigation.incidentId.filter(inc.incidentId)];
    expect(inv).toHaveLength(1);
    expect(inv[0]!.status).toBe('requested');
  });

  it('degrades the physical asset and the modeled dependents; never touches telemetry of the sensor asset', () => {
    const { h, reg, read } = setup();
    reg();
    for (let i = 0; i < 6; i++) read(23.5, 41);
    read(31, 41);
    read(32, 41);
    expect(h.db.asset.assetId.find('env-uno-r4-01')!.healthStatus).toBe('degraded');
    expect(h.db.asset.assetId.find('primary-db')!.healthStatus).toBe('degraded'); // MODELED consequence
    const inc = [...h.db.incident.iter()][0]!;
    const hit = [...h.db.incidentAsset.incidentId.filter(inc.incidentId)];
    expect(hit.length).toBeGreaterThan(1);
  });

  it('opens a humidity incident from a real humidity breach', () => {
    const { h, reg, read } = setup();
    reg();
    for (let i = 0; i < 4; i++) read(23.5, 41);
    read(24, 82);
    read(24, 85);
    const inc = [...h.db.incident.iter()][0]!;
    expect(inc.title).toMatch(/humidity/);
  });

  it('records a measured "readings normalized" event once and keeps the incident open for humans', () => {
    const { h, reg, read } = setup();
    reg();
    for (let i = 0; i < 6; i++) read(23.5, 41);
    read(31, 41);
    read(32, 41);
    for (let i = 0; i < 8; i++) read(23.5, 41);
    const inc = [...h.db.incident.iter()][0]!;
    expect(inc.status).toBe('open');
    const normalized = [...h.db.incidentEvent.incidentId.filter(inc.incidentId)].filter(e => e.eventType === 'readings_normalized');
    expect(normalized).toHaveLength(1);
  });

  it('runs the full human-approved recovery path on a real incident (two-person rule intact)', () => {
    const { h, reg, read, ic, analyst } = setup();
    reg();
    for (let i = 0; i < 6; i++) read(23.5, 41);
    read(31, 41);
    read(32, 41);
    const inc = [...h.db.incident.iter()][0]!;
    // The gateway cannot approve or request recovery: it is not a responder.
    const gw = auth('gw', 4n);
    expect(() => h.withReducerTx(gw, ctx => m.request_recovery(ctx, { incidentId: inc.incidentId, assetId: 'env-uno-r4-01', plan: 'Restore cooling (simulated)' }))).toThrow(/register as a responder/);
    h.withReducerTx(analyst, ctx => m.request_recovery(ctx, { incidentId: inc.incidentId, assetId: 'env-uno-r4-01', plan: 'Restore cooling (simulated)' }));
    const rec = [...h.db.recoveryAction.incidentId.filter(inc.incidentId)][0]!;
    h.withReducerTx(ic, ctx => m.decide_recovery(ctx, { recoveryId: rec.recoveryId, approve: true, note: 'Cooling restored' }));
    expect([...h.db.recoveryAction.incidentId.filter(inc.incidentId)][0]!.status).toBe('approved');
  });

  it('reset_demo_environment refuses to close a real incident', () => {
    const { h, reg, read, ic } = setup();
    reg();
    for (let i = 0; i < 6; i++) read(23.5, 41);
    read(31, 41);
    read(32, 41);
    expect(() => h.withReducerTx(ic, ctx => m.reset_demo_environment(ctx, {}))).toThrow(/non-simulated incident/);
  });
});

describe('sensor silent (monitoring lost)', () => {
  it('opens one real incident with measured evidence, and notes when the node resumes', () => {
    const { h, gw, reg, read } = setup();
    reg();
    for (let i = 0; i < 3; i++) read(23.5, 41);
    h.withReducerTx(gw, ctx => m.report_sensor_fault(ctx, { nodeId: 'uno-r4-01', kind: 'silent', detail: 'No heartbeat for 45 s' }));
    h.withReducerTx(gw, ctx => m.report_sensor_fault(ctx, { nodeId: 'uno-r4-01', kind: 'silent', detail: 'No heartbeat for 60 s' }));
    const incs = [...h.db.incident.iter()];
    expect(incs).toHaveLength(1);
    const inc = incs[0]!;
    expect(inc.scenarioType).toBe('sensor_silent');
    expect(inc.isSimulation).toBe(false);
    expect([...h.db.incidentEvidence.incidentId.filter(inc.incidentId)].every(e => e.synthetic === false)).toBe(true);
    expect(h.db.sensorNode.nodeId.find('uno-r4-01')!.status).toBe('silent');
    read(23.5, 41);
    expect(h.db.sensorNode.nodeId.find('uno-r4-01')!.status).toBe('online');
    expect([...h.db.incidentEvent.incidentId.filter(inc.incidentId)].some(e => e.eventType === 'sensor_back_online')).toBe(true);
  });
  it('does not open a second ticket while an older real incident for the asset is still open', () => {
    const { h, gw, reg, read } = setup();
    reg();
    for (let i = 0; i < 3; i++) read(23.5, 41);
    // Silent ticket first; node resumes (ticket stays open), then goes silent again.
    h.withReducerTx(gw, ctx => m.report_sensor_fault(ctx, { nodeId: 'uno-r4-01', kind: 'silent', detail: 'No heartbeat for 45 s' }));
    read(23.5, 41);
    h.withReducerTx(gw, ctx => m.report_sensor_fault(ctx, { nodeId: 'uno-r4-01', kind: 'silent', detail: 'No heartbeat for 50 s' }));
    expect([...h.db.incident.iter()]).toHaveLength(1);
    // A thermal excursion while that ticket is open attaches to it instead of opening another.
    read(31, 41);
    read(32, 41);
    read(33, 41);
    const incs = [...h.db.incident.iter()];
    expect(incs).toHaveLength(1);
    expect([...h.db.incidentEvent.incidentId.filter(incs[0]!.incidentId)].some(e => e.eventType === 'readings_out_of_range')).toBe(true);
  });
  it('rejects unknown fault kinds', () => {
    const { h, gw, reg } = setup();
    reg();
    expect(() => h.withReducerTx(gw, ctx => m.report_sensor_fault(ctx, { nodeId: 'uno-r4-01', kind: 'exploded', detail: 'whatever' }))).toThrow(/fault kind/);
  });
});
