// Pure helpers: search/filtering, blast-radius view model, incident search/sort.
import { describe, expect, it } from 'vitest';
import { loadScenario } from './fixtures/load';
import { filterAssets, matchesHealth, isFilterActive, EMPTY_FILTER, type HealthFilter } from '../lib/twinFilters';
import { classifyEdge, deriveBlast, groupOf } from '../lib/blast';
import { EMPTY_INCIDENT_FILTER, filterIncidents, matchesIncidentQuery } from '../lib/derive';

const d = loadScenario();
const f = (query = '', health: HealthFilter[] = [], assetType = '') => ({ query, health: new Set(health), assetType });

describe('twin search and filters', () => {
  it('matches by name, id and type; empty filter matches all', () => {
    expect(filterAssets(d.assets, EMPTY_FILTER)).toHaveLength(16);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(filterAssets(d.assets, f('DATABASE'))).toEqual(['primary-db']);
    expect(filterAssets(d.assets, f('auth-svc'))).toEqual(['auth-svc']);
    expect(filterAssets(d.assets, f('web application'))).toEqual(['customer-portal', 'admin-portal']); // sorted by name
  });

  it('combines health, type and query filters', () => {
    expect(filterAssets(d.assets, f('', ['critical'])).sort()).toEqual(['auth-svc', 'ext-gateway', 'primary-db']);
    expect(filterAssets(d.assets, f('', ['offline'], 'web_application')).sort()).toEqual(['admin-portal', 'customer-portal']);
    expect(filterAssets(d.assets, f('zzz'))).toEqual([]);
  });

  it('"at risk" matches exposed services', () => {
    expect(matchesHealth({ healthStatus: 'healthy', impactType: 'exposed' }, new Set<HealthFilter>(['at_risk']))).toBe(true);
    expect(matchesHealth({ healthStatus: 'healthy', impactType: 'none' }, new Set<HealthFilter>(['at_risk']))).toBe(false);
  });
});

describe('blast-radius view model', () => {
  const db = d.incidents.find(i => i.scenarioType === 'database_outage')!;
  it('groups root, direct and indirect from recorded rows, matching the stored depths', () => {
    const b = deriveBlast(db.incidentId, d.incidentAssets, d.effects, d.dependencies, d.assetById);
    expect(b.root).toBe(1);
    expect(b.entries.find(e => e.group === 'root')?.assetId).toBe('primary-db');
    expect(b.entries.filter(e => e.group === 'direct').map(e => e.assetId).sort()).toEqual(['analytics-svc', 'app-api', 'auth-svc', 'payment-svc']);
    expect(b.entries.filter(e => e.group === 'indirect').map(e => e.assetId).sort()).toEqual(['admin-portal', 'customer-portal']);
    expect(b.total).toBe(7);
    expect(b.maxDepth).toBe(2);
    expect(b.criticalAffected.length).toBeGreaterThanOrEqual(5);
  });

  it('builds dependency paths and reasons from recorded causes', () => {
    const b = deriveBlast(db.incidentId, d.incidentAssets, d.effects, d.dependencies, d.assetById);
    const portal = b.entries.find(e => e.assetId === 'customer-portal')!;
    expect(portal.path[0]).toBe('primary-db');
    expect(portal.path[portal.path.length - 1]).toBe('customer-portal');
    expect(portal.path.length).toBe(3);
    expect(b.entries.find(e => e.assetId === 'analytics-svc')?.reason).toMatch(/noncritical dependency on Primary Database/);
    expect(b.entries.find(e => e.group === 'root')?.reason).toBe('Confirmed outage (root cause)');
  });

  it('classifies exposure rows and edges', () => {
    expect(groupOf({ impactType: 'cascade', impactStatus: 'exposed', depth: 2 })).toBe('exposed');
    expect(groupOf({ impactType: 'direct', impactStatus: 'degraded', depth: 0 })).toBe('root');
    expect(classifyEdge({ status: 'offline', causedBy: 'db', exposedFrom: null }, 'db', true, true)).toBe('direct');
    expect(classifyEdge({ status: 'offline', causedBy: 'api', exposedFrom: null }, 'api', false, true)).toBe('indirect');
    expect(classifyEdge({ status: 'exposed', causedBy: null, exposedFrom: 'auth' }, 'auth', true, true)).toBe('exposure');
    expect(classifyEdge({ status: null, causedBy: null, exposedFrom: null }, 'x', false, false)).toBe('normal');
  });
});

describe('incident search and sorting', () => {
  const affected = new Map<bigint, Set<string>>();
  it('searches by title and INC id', () => {
    const surge = d.incidents.find(i => i.scenarioType === 'traffic_surge')!;
    expect(matchesIncidentQuery(surge, 'surge')).toBe(true);
    expect(matchesIncidentQuery(surge, `INC-${surge.incidentId}`)).toBe(true);
    expect(matchesIncidentQuery(surge, `${surge.incidentId}`)).toBe(true);
    expect(matchesIncidentQuery(surge, 'database')).toBe(false);
  });

  it('sorts newest, oldest and by severity deterministically', () => {
    const ids = (sort: typeof EMPTY_INCIDENT_FILTER.sort) => filterIncidents(d.incidents, affected, { ...EMPTY_INCIDENT_FILTER, sort }).map(i => Number(i.incidentId));
    expect(ids('newest')).toEqual([3, 2, 1]);
    expect(ids('oldest')).toEqual([1, 2, 3]);
    const sev = filterIncidents(d.incidents, affected, { ...EMPTY_INCIDENT_FILTER, sort: 'severity' }).map(i => i.severity);
    expect(sev).toEqual(['critical', 'critical', 'high']);
  });
});
