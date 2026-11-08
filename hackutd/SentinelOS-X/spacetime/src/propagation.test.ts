import { describe, expect, it } from 'vitest';
import { computeImpacts, edgeImpact, severityFromImpacts, statusesFor, type GraphEdge } from './propagation';

const e = (dependentAssetId: string, requiredAssetId: string, dependencyType: GraphEdge['dependencyType'] = 'required'): GraphEdge => ({
  dependentAssetId,
  requiredAssetId,
  dependencyType,
});

describe('edge policy', () => {
  it('applies required / noncritical / optional semantics', () => {
    expect(edgeImpact('required', 'offline')).toBe('offline');
    expect(edgeImpact('required', 'degraded')).toBe('degraded');
    expect(edgeImpact('noncritical', 'offline')).toBe('degraded');
    expect(edgeImpact('noncritical', 'degraded')).toBe('degraded');
    expect(edgeImpact('optional', 'offline')).toBe('healthy');
    expect(edgeImpact('required', 'healthy')).toBe('healthy');
  });
});

describe('computeImpacts', () => {
  it('marks only the direct failure when nothing depends on it', () => {
    const r = computeImpacts(['a', 'b'], [], new Map([['a', 'offline']]));
    expect(r.get('a')).toMatchObject({ level: 'offline', impactType: 'direct', depth: 0 });
    expect(r.get('b')).toMatchObject({ level: 'healthy', impactType: 'none' });
  });

  it('propagates a single level through a required edge', () => {
    const r = computeImpacts(['api', 'db'], [e('api', 'db')], new Map([['db', 'offline']]));
    expect(r.get('api')).toMatchObject({ level: 'offline', impactType: 'cascade', depth: 1, causedBy: 'db', via: 'required' });
  });

  it('cascades across multiple levels and distinguishes direct from cascade', () => {
    const edges = [e('portal', 'api'), e('api', 'auth'), e('auth', 'db'), e('api', 'db')];
    const r = computeImpacts(['portal', 'api', 'auth', 'db'], edges, new Map([['db', 'offline']]));
    expect(r.get('db')?.impactType).toBe('direct');
    expect(r.get('auth')).toMatchObject({ level: 'offline', impactType: 'cascade', depth: 1 });
    expect(r.get('api')).toMatchObject({ level: 'offline', impactType: 'cascade', depth: 1, causedBy: 'db' });
    expect(r.get('portal')).toMatchObject({ level: 'offline', impactType: 'cascade', depth: 2, causedBy: 'api' });
  });

  it('degrades through noncritical edges and ignores optional ones', () => {
    const edges = [e('api', 'files', 'noncritical'), e('portal', 'api'), e('api', 'metrics', 'optional')];
    const r1 = computeImpacts(['api', 'files', 'portal', 'metrics'], edges, new Map([['files', 'offline']]));
    expect(r1.get('api')?.level).toBe('degraded');
    expect(r1.get('portal')?.level).toBe('degraded'); // required on a degraded asset
    const r2 = computeImpacts(['api', 'files', 'portal', 'metrics'], edges, new Map([['metrics', 'offline']]));
    expect(r2.get('api')?.level).toBe('healthy');
  });

  it('terminates on cyclic dependencies', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('d', 'c', 'noncritical')];
    const r = computeImpacts(['a', 'b', 'c', 'd'], edges, new Map([['a', 'offline']]));
    expect(r.get('a')).toMatchObject({ level: 'offline', impactType: 'direct' });
    expect(r.get('c')).toMatchObject({ level: 'offline', impactType: 'cascade' });
    expect(r.get('b')).toMatchObject({ level: 'offline', impactType: 'cascade' });
    expect(r.get('d')?.level).toBe('degraded');
  });

  it('leaves independent components untouched', () => {
    const edges = [e('api', 'db'), e('backup', 'vault')];
    const r = computeImpacts(['api', 'db', 'backup', 'vault'], edges, new Map([['db', 'offline']]));
    expect(r.get('backup')?.level).toBe('healthy');
    expect(r.get('vault')?.level).toBe('healthy');
  });

  it('escalates degraded to offline when a worse path exists', () => {
    const edges = [e('api', 'files', 'noncritical'), e('api', 'db')];
    const r = computeImpacts(['api', 'files', 'db'], edges, new Map([['files', 'offline'], ['db', 'offline']]));
    expect(r.get('api')).toMatchObject({ level: 'offline', causedBy: 'db', via: 'required' });
  });

  it('is deterministic regardless of edge order', () => {
    const edges = [e('portal', 'api'), e('api', 'db'), e('api', 'auth'), e('auth', 'db')];
    const a = computeImpacts(['portal', 'api', 'auth', 'db'], edges, new Map([['db', 'offline']]));
    const b = computeImpacts(['db', 'auth', 'api', 'portal'], [...edges].reverse(), new Map([['db', 'offline']]));
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

describe('severity and status mapping', () => {
  it('derives severity from asset criticality and impact', () => {
    const r = computeImpacts(['api', 'db'], [e('api', 'db')], new Map([['db', 'offline']]));
    expect(severityFromImpacts(r.values(), id => (id === 'db' ? 'mission_critical' : 'high'))).toBe('critical');
    expect(severityFromImpacts(r.values(), () => 'medium')).toBe('medium');
  });

  it('maps direct offline to critical health and cascade offline to offline health', () => {
    const r = computeImpacts(['api', 'db'], [e('api', 'db')], new Map([['db', 'offline']]));
    expect(statusesFor(r.get('db')!)).toEqual({ operationalStatus: 'offline', healthStatus: 'critical' });
    expect(statusesFor(r.get('api')!)).toEqual({ operationalStatus: 'offline', healthStatus: 'offline' });
  });
});
