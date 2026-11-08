import { describe, expect, it } from 'vitest';
import { computeBlastRadius, severityFromBlast, resolveEffect, type EffectInput, type GraphEdge } from './propagation';
import { DEMO_ASSETS as SEED_ASSETS, DEMO_EDGES as SEED_EDGES } from './seed';

const e = (dependentAssetId: string, requiredAssetId: string, dependencyType: GraphEdge['dependencyType'] = 'required'): GraphEdge => ({ dependentAssetId, requiredAssetId, dependencyType });
const fx = (assetId: string, kind: EffectInput['kind'], phase: EffectInput['phase'] = 'active', level: EffectInput['level'] = kind === 'outage' ? 'offline' : 'degraded', intensity = 0): EffectInput => ({ assetId, kind, level, phase, intensity });

// Seed topology used by the real demo.
const ids = SEED_ASSETS.map(a => a.assetId);
const edges = SEED_EDGES.map(x => e(x.dependent, x.required, x.type));
const crit = new Map(SEED_ASSETS.map(a => [a.assetId, a.criticality]));
const critOf = (id: string) => crit.get(id) ?? 'low';

describe('graph traversal edge cases', () => {
  it('handles an empty graph', () => {
    expect(computeBlastRadius([], [], [fx('x', 'outage')]).size).toBe(0);
  });

  it('ignores effects on unknown assets and leaves disconnected assets untouched', () => {
    const r = computeBlastRadius(['a', 'island'], [], [fx('ghost', 'outage'), fx('a', 'outage')]);
    expect(r.get('a')?.role).toBe('root');
    expect(r.get('island')).toMatchObject({ role: 'none', health: 'healthy', impactClass: 'none' });
  });

  it('is unaffected by duplicate edges and self-loops', () => {
    const dup = [e('b', 'a'), e('b', 'a'), e('b', 'a'), e('a', 'a')];
    const r = computeBlastRadius(['a', 'b'], dup, [fx('a', 'outage')]);
    expect(r.get('b')).toMatchObject({ level: 'offline', depth: 1, causedBy: 'a' });
  });

  it('terminates on cycles for both operational and exposure traversal', () => {
    const cyc = [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('d', 'c', 'noncritical')];
    const r1 = computeBlastRadius(['a', 'b', 'c', 'd'], cyc, [fx('a', 'outage')]);
    expect([...r1.values()].filter(x => x.role !== 'none')).toHaveLength(4);
    const r2 = computeBlastRadius(['a', 'b', 'c', 'd'], cyc, [fx('a', 'compromise')]);
    expect(r2.get('c')).toMatchObject({ exposed: true, exposureDepth: 1 });
    expect(r2.get('b')).toMatchObject({ exposed: true, exposureDepth: 2 });
    expect(r2.get('a')?.role).toBe('root');
  });

  it('is deterministic regardless of input order', () => {
    const a = computeBlastRadius(ids, edges, [fx('primary-db', 'outage'), fx('auth-svc', 'compromise')]);
    const b = computeBlastRadius([...ids].reverse(), [...edges].reverse(), [fx('auth-svc', 'compromise'), fx('primary-db', 'outage')]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

describe('scenario rules on the seed topology', () => {
  it('database outage: root, direct (hop 1) and indirect (hop ≥ 2) operational impact', () => {
    const r = computeBlastRadius(ids, edges, [fx('primary-db', 'outage')]);
    expect(r.get('primary-db')).toMatchObject({ role: 'root', health: 'critical', operationalStatus: 'offline', impactClass: 'confirmed' });
    for (const id of ['auth-svc', 'app-api', 'payment-svc']) expect(r.get(id)).toMatchObject({ impactClass: 'unavailable', depth: 1 });
    expect(r.get('analytics-svc')).toMatchObject({ impactClass: 'degraded', depth: 1, via: 'noncritical' });
    expect(r.get('customer-portal')).toMatchObject({ impactClass: 'unavailable', depth: 2 });
    expect(r.get('backup-vault')?.role).toBe('none');
    expect(severityFromBlast(r.values(), critOf)).toBe('critical');
  });

  it('authentication compromise flags dependents as exposed without degrading them', () => {
    const r = computeBlastRadius(ids, edges, [fx('auth-svc', 'compromise')]);
    expect(r.get('auth-svc')).toMatchObject({ role: 'root', health: 'critical', impactClass: 'confirmed' });
    for (const id of ['app-api', 'payment-svc', 'admin-portal']) expect(r.get(id)).toMatchObject({ impactClass: 'exposed', health: 'healthy', exposureDepth: 1, exposureFrom: 'auth-svc' });
    expect(r.get('customer-portal')).toMatchObject({ impactClass: 'exposed', exposureDepth: 2 });
    // No dependent is operationally impacted or "compromised".
    expect([...r.values()].filter(x => x.role === 'dependent' && x.level !== 'healthy')).toHaveLength(0);
    expect(severityFromBlast(r.values(), critOf)).toBe('critical');
  });

  it('traffic surge degrades but never exposes; saturation makes the gateway critical', () => {
    const r = computeBlastRadius(ids, edges, [fx('ext-gateway', 'overload')]);
    expect(r.get('ext-gateway')).toMatchObject({ health: 'degraded', operationalStatus: 'degraded' });
    expect(r.get('customer-portal')).toMatchObject({ impactClass: 'degraded', depth: 1 });
    expect([...r.values()].some(x => x.exposed)).toBe(false);
    expect(severityFromBlast(r.values(), critOf)).toBe('medium');
    const sat = computeBlastRadius(ids, edges, [fx('ext-gateway', 'overload', 'active', 'degraded', 1)]);
    expect(sat.get('ext-gateway')?.health).toBe('critical');
    expect(severityFromBlast(sat.values(), critOf)).toBe('high');
  });

  it('file-service ransomware degrades consumers and exposes them; isolation stops exposure but takes it offline', () => {
    const active = computeBlastRadius(ids, edges, [fx('file-storage', 'integrity')]);
    expect(active.get('file-storage')).toMatchObject({ health: 'critical', operationalStatus: 'degraded' });
    expect(active.get('app-api')).toMatchObject({ impactClass: 'degraded', exposed: true });
    expect(active.get('customer-portal')).toMatchObject({ impactClass: 'degraded', depth: 2 });
    const isolated = computeBlastRadius(ids, edges, [fx('file-storage', 'integrity', 'contained')]);
    expect(isolated.get('file-storage')).toMatchObject({ operationalStatus: 'offline', health: 'critical' });
    expect([...isolated.values()].some(x => x.exposed)).toBe(false);
  });

  it('marks impact that only stems from recovering effects as recovering', () => {
    const r = computeBlastRadius(ids, edges, [fx('primary-db', 'outage', 'recovering')]);
    expect(r.get('primary-db')?.health).toBe('recovering');
    expect(r.get('auth-svc')).toMatchObject({ health: 'recovering', level: 'degraded' });
    expect(computeBlastRadius(ids, edges, [fx('primary-db', 'outage', 'cleared')]).get('primary-db')?.role).toBe('none');
  });

  it('overlapping incidents: the worst live effect wins and clearing one keeps the other', () => {
    const both = computeBlastRadius(ids, edges, [fx('primary-db', 'outage', 'recovering'), fx('primary-db', 'fault', 'active', 'offline')]);
    expect(both.get('primary-db')?.health).toBe('critical');
    expect(both.get('auth-svc')?.health).toBe('offline');
  });

  it('a recovering root still taken down by another incident reports offline, then recovering once that clears', () => {
    const held = computeBlastRadius(ids, edges, [fx('auth-svc', 'compromise', 'recovering'), fx('primary-db', 'outage', 'active', 'offline')]);
    expect(held.get('auth-svc')).toMatchObject({ role: 'root', health: 'offline', operationalStatus: 'offline' });
    const slow = computeBlastRadius(ids, edges, [fx('auth-svc', 'compromise', 'recovering'), fx('primary-db', 'fault', 'active', 'degraded')]);
    expect(slow.get('auth-svc')?.health).toBe('degraded');
    const alone = computeBlastRadius(ids, edges, [fx('auth-svc', 'compromise', 'recovering'), fx('primary-db', 'outage', 'cleared')]);
    expect(alone.get('auth-svc')?.health).toBe('recovering');
    const contained = computeBlastRadius(ids, edges, [fx('ext-gateway', 'overload', 'contained', 'degraded', 1), fx('primary-db', 'outage', 'active', 'offline')]);
    expect(contained.get('ext-gateway')?.health).not.toBe('recovering');
  });

  it('containment changes how effects resolve', () => {
    expect(resolveEffect(fx('a', 'compromise', 'contained'))?.exposes).toBe(false);
    expect(resolveEffect(fx('a', 'overload', 'contained', 'degraded', 1))?.rootHealth).toBe('degraded');
    expect(resolveEffect(fx('a', 'outage', 'cleared'))).toBeNull();
  });
});
