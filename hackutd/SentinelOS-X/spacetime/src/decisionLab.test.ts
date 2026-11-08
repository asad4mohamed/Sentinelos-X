import { describe, expect, it } from 'vitest';
import { DEMO_ASSETS, DEMO_EDGES } from './seed';
import { evaluateAll, evaluateStrategy, LabError, rootTargets, stateFingerprint, summarize, type LabEffect, type LabInput } from './decisionLab';
import type { GraphEdge } from './propagation';

const assets = DEMO_ASSETS.map(a => ({ assetId: a.assetId, name: a.name, criticality: a.criticality }));
const edges: GraphEdge[] = DEMO_EDGES.map(e => ({ dependentAssetId: e.dependent, requiredAssetId: e.required, dependencyType: e.type }));

const eff = (assetId: string, kind: LabEffect['kind'], level: LabEffect['level'], phase: LabEffect['phase'] = 'active', incidentId = '1'): LabEffect => ({ incidentId, assetId, kind, level, phase, intensity: 0 });

function input(effects: LabEffect[], targetAssetId: string, extra: Partial<LabInput> = {}): LabInput {
  return { incidentId: '1', incidentStatus: 'open', assets, edges, effects, targetAssetId, pendingRecoveryAssetIds: [], ...extra };
}

const dbOutage = () => input([eff('primary-db', 'outage', 'offline')], 'primary-db');

describe('Decision Lab — database outage', () => {
  it('restore returns every dependent to healthy and requires two-person approval', () => {
    const r = evaluateStrategy(dbOutage(), 'restore');
    expect(r.support).toBe('executable');
    expect(r.before.assets['app-api']!.state).toBe('offline');
    expect(r.before.assets['auth-svc']!.state).toBe('offline');
    expect(r.after.counts.healthy).toBe(assets.length);
    expect(r.restored).toEqual(expect.arrayContaining(['primary-db', 'app-api', 'auth-svc', 'payment-svc', 'customer-portal', 'admin-portal', 'analytics-svc']));
    expect(r.disrupted).toEqual([]);
    expect(r.steps.map(s => s.operation)).toEqual(['request_recovery', 'decide_recovery']);
    expect(r.steps.find(s => s.operation === 'decide_recovery')!.approval).toBe('two_person');
    expect(r.preconditions.every(p => p.met)).toBe(true);
    expect(r.stages.map(s => s.label)).toEqual(['While recovering', 'After recovery completes']);
    expect(r.stages[0]!.impact.assets['primary-db']!.state).toBe('recovering');
    expect(r.before.severity).toBe('critical');
    expect(r.after.severity).toBe('none');
  });

  it('isolate is labelled hypothetical because outages have no backend isolation', () => {
    const r = evaluateStrategy(dbOutage(), 'isolate');
    expect(r.support).toBe('hypothetical');
    expect(r.unsupported.join(' ')).toMatch(/no isolation operation/);
    expect(r.restored).toEqual([]);
    expect(r.stillAffected).toContain('primary-db');
  });

  it('failover is always hypothetical and states its standby assumption', () => {
    const r = evaluateStrategy(dbOutage(), 'failover');
    expect(r.support).toBe('hypothetical');
    expect(r.assumptions.join(' ')).toMatch(/standby .* ASSUMPTION/);
    expect(r.after.counts.healthy).toBe(assets.length);
  });

  it('staged skips containment when none exists and still recovers', () => {
    const r = evaluateStrategy(dbOutage(), 'staged');
    expect(r.steps[0]!.operation).toBe('no_op');
    expect(r.stages.at(-1)!.impact.counts.healthy).toBe(assets.length);
  });

  it('never invents quantities: no probability, time or cost fields', () => {
    const json = JSON.stringify(evaluateAll(dbOutage()));
    expect(json).not.toMatch(/probab|percent|minutes|cost|confidence|\$/i);
  });
});

describe('Decision Lab — security incidents', () => {
  it('compromise: restore precondition unmet until contained; staged contains first', () => {
    const inp = input([eff('auth-svc', 'compromise', 'degraded')], 'auth-svc');
    const restore = evaluateStrategy(inp, 'restore');
    expect(restore.preconditions.find(p => /contained/.test(p.text))!.met).toBe(false);
    expect(restore.warnings.join(' ')).toMatch(/reject a recovery request until/);
    const staged = evaluateStrategy(inp, 'staged');
    expect(staged.steps.map(s => s.operation)).toEqual(['apply_containment', 'request_recovery', 'decide_recovery']);
    expect(staged.stages[0]!.impact.counts.exposed).toBe(0);
    expect(staged.before.counts.exposed).toBeGreaterThan(0);
    expect(staged.support).toBe('executable');
  });

  it('compromise: failover leaves the modeled exposure unchanged', () => {
    const r = evaluateStrategy(input([eff('auth-svc', 'compromise', 'degraded')], 'auth-svc'), 'failover');
    expect(r.after.counts.exposed).toBe(r.before.counts.exposed);
    expect(r.residualRisks.join(' ')).toMatch(/does not remediate/);
  });

  it('integrity: isolation stops exposure but disrupts services that require file storage', () => {
    const r = evaluateStrategy(input([eff('file-storage', 'integrity', 'degraded')], 'file-storage'), 'isolate');
    expect(r.support).toBe('executable');
    expect(r.after.assets['file-storage']!.state).toBe('offline');
    expect(r.after.counts.exposed).toBe(0);
    expect(r.residualRisks.join(' ')).toMatch(/lateral spread/);
  });

  it('already-contained target: isolate is a no-op with a warning', () => {
    const r = evaluateStrategy(input([eff('auth-svc', 'compromise', 'degraded', 'contained')], 'auth-svc'), 'isolate');
    expect(r.steps[0]!.operation).toBe('no_op');
    expect(r.disrupted).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/already in place/);
  });
});

describe('Decision Lab — robustness', () => {
  it('handles cyclic graphs', () => {
    const cyc: GraphEdge[] = [
      { dependentAssetId: 'a', requiredAssetId: 'b', dependencyType: 'required' },
      { dependentAssetId: 'b', requiredAssetId: 'c', dependencyType: 'required' },
      { dependentAssetId: 'c', requiredAssetId: 'a', dependencyType: 'required' },
    ];
    const as = ['a', 'b', 'c', 'island'].map(id => ({ assetId: id, name: id.toUpperCase(), criticality: 'high' as const }));
    const inp: LabInput = { incidentId: '9', incidentStatus: 'open', assets: as, edges: cyc, effects: [eff('a', 'outage', 'offline', 'active', '9')], targetAssetId: 'a', pendingRecoveryAssetIds: [] };
    const r = evaluateStrategy(inp, 'restore');
    expect(r.before.counts.offline).toBe(3);
    expect(r.after.counts.healthy).toBe(4);
    expect(r.before.assets['island']!.state).toBe('healthy'); // disconnected service untouched
  });

  it('rejects missing services, non-root targets, invalid strategies and resolved incidents', () => {
    expect(() => evaluateStrategy(input([eff('primary-db', 'outage', 'offline')], 'ghost-svc'), 'restore')).toThrow(/does not exist/);
    expect(() => evaluateStrategy(input([eff('primary-db', 'outage', 'offline')], 'app-api'), 'restore')).toThrow(/not a live root cause/);
    expect(() => evaluateStrategy(dbOutage(), 'reboot_everything')).toThrow(LabError);
    expect(() => evaluateStrategy({ ...dbOutage(), incidentStatus: 'resolved' }, 'restore')).toThrow(/resolved/);
    expect(() => evaluateStrategy(input([], 'primary-db'), 'restore')).toThrow(/no live root effect/);
  });

  it('ignores effects referencing unknown assets', () => {
    const r = evaluateStrategy(input([eff('primary-db', 'outage', 'offline'), eff('ghost', 'outage', 'offline')], 'primary-db'), 'restore');
    expect(r.after.counts.healthy).toBe(assets.length);
  });

  it('does not mutate its input and is deterministic', () => {
    const inp = dbOutage();
    const frozen = JSON.stringify(inp);
    const a = JSON.stringify(evaluateAll(inp));
    const b = JSON.stringify(evaluateAll(inp));
    expect(a).toBe(b);
    expect(JSON.stringify(inp)).toBe(frozen);
  });

  it('pending recovery makes the restore precondition unmet', () => {
    const r = evaluateStrategy({ ...dbOutage(), pendingRecoveryAssetIds: ['primary-db'] }, 'restore');
    expect(r.preconditions.find(p => /already pending/.test(p.text))!.met).toBe(false);
  });

  it('reports other root causes and other incidents, without mixing them in', () => {
    const inp = input([eff('primary-db', 'outage', 'offline'), eff('message-queue', 'fault', 'offline'), eff('ext-gateway', 'overload', 'degraded', 'active', '2')], 'primary-db');
    expect(rootTargets(inp)).toEqual(['message-queue', 'primary-db']);
    const r = evaluateStrategy(inp, 'restore');
    expect(r.residualRisks.join(' ')).toMatch(/Message Queue/);
    expect(r.warnings.join(' ')).toMatch(/#2/);
    expect(r.after.assets['ext-gateway']!.state).toBe('healthy'); // incident 2 not combined
  });

  it('fingerprint changes when phases change, not when overload intensity ticks', () => {
    const base = input([eff('ext-gateway', 'overload', 'degraded')], 'ext-gateway');
    const f0 = stateFingerprint(base);
    expect(stateFingerprint({ ...base, effects: [{ ...base.effects[0]!, intensity: 0.8 }] })).toBe(f0);
    expect(stateFingerprint({ ...base, effects: [{ ...base.effects[0]!, phase: 'contained' }] })).not.toBe(f0);
    expect(stateFingerprint({ ...base, incidentStatus: 'contained' })).not.toBe(f0);
  });

  it('summary is computed from engine output only', () => {
    expect(summarize(evaluateStrategy(dbOutage(), 'restore'))).toMatch(/modeled severity critical → none/);
  });
});

import { recommend } from './decisionLab';
describe('Decision Lab — deterministic recommendation', () => {
  it('outage: recommends an executable recovery, never the hypothetical failover', () => {
    const rec = recommend(evaluateAll(dbOutage()))!;
    expect(['restore', 'staged']).toContain(rec.strategy);
    expect(rec.rationale).toMatch(/Fail over to a standby \(hypothetical/);
  });
  it('compromise: prefers staged (preconditions met) over restore (needs containment first)', () => {
    const rec = recommend(evaluateAll(input([eff('auth-svc', 'compromise', 'degraded')], 'auth-svc')))!;
    expect(rec.strategy).toBe('staged');
  });
  it('is deterministic', () => {
    expect(recommend(evaluateAll(dbOutage()))).toEqual(recommend(evaluateAll(dbOutage())));
  });
});
