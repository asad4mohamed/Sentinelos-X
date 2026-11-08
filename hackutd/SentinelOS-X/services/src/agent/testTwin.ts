// Test helper: a TwinView of the real seed topology with the ransomware
// scenario applied (primary-db directly offline under incident 1), computed
// with the same propagation engine the server uses.
import { computeImpacts, statusesFor, type DependencyType } from '../../../spacetime/src/propagation';
import { SEED_ASSETS, SEED_EDGES } from '../../../spacetime/src/seed';
import type { TwinAsset, TwinView } from './twin';

export function ransomwareTwin(): TwinView {
  const edges = SEED_EDGES.map(e => ({ dependentAssetId: e.dependent, requiredAssetId: e.required, dependencyType: e.type as DependencyType, rationale: e.rationale }));
  const impacts = computeImpacts(SEED_ASSETS.map(a => a.assetId), edges, new Map([['primary-db', 'offline']]));
  const assets: TwinAsset[] = SEED_ASSETS.map(a => {
    const imp = impacts.get(a.assetId)!;
    const st = statusesFor(imp);
    return {
      assetId: a.assetId,
      name: a.name,
      assetType: a.assetType,
      environment: a.environment,
      criticality: a.criticality,
      healthStatus: st.healthStatus,
      operationalStatus: st.operationalStatus,
      impactType: imp.impactType,
      impactCausedBy: imp.causedBy,
      directFailure: a.assetId === 'primary-db' ? 'offline' : 'none',
      directIncidentId: a.assetId === 'primary-db' ? '1' : null,
    };
  });
  return {
    assets: () => assets,
    edges: () => edges,
    incident: id =>
      id === '1'
        ? { incidentId: '1', title: 'Simulated ransomware disruption — Primary Database', severity: 'critical', status: 'open', scenarioType: 'simulated_ransomware', initialAssetId: 'primary-db', isSimulation: true, createdAt: '2026-11-07T20:00:00.000Z' }
        : undefined,
    impacts: id =>
      id === '1'
        ? [...impacts.values()].filter(i => i.level !== 'healthy').map(i => ({ assetId: i.assetId, impactType: i.impactType, impactStatus: i.level, peakStatus: i.level, depth: i.depth, causedByAssetId: i.causedBy }))
        : [],
    events: () => [{ timestamp: '2026-11-07T20:00:00.000Z', eventType: 'incident_created', actorName: 'Ben', description: 'Simulated incident opened', assetId: null }],
    telemetry: assetId =>
      assetId === 'primary-db'
        ? [{ latencyMs: 0, errorRate: 1, cpuPct: 97, throughputRpm: 0, timestamp: '2026-11-07T20:00:02.000Z' }]
        : [],
    recoveries: () => [],
    evidence: () => [],
    sensorNodeFor: () => undefined,
    sensorReadings: () => [],
  };
}

/** Test helper: a REAL environmental incident opened from a physical sensor (heat excursion in the closet). */
export function sensorTwin(): TwinView {
  const base = ransomwareTwin();
  const envAsset: TwinAsset = { assetId: 'env-uno-r4-01', name: 'Server closet (environment)', assetType: 'environment_sensor', environment: 'physical', criticality: 'high', healthStatus: 'degraded', operationalStatus: 'degraded', impactType: 'direct', impactCausedBy: null, directFailure: 'degraded', directIncidentId: '7' };
  const t0 = Date.parse('2026-11-08T01:00:00.000Z');
  const readings = Array.from({ length: 12 }, (_, i) => ({ tempC: i < 8 ? 23.5 : 31 + (i - 8), humidityPct: 41, timestamp: new Date(t0 + i * 4000).toISOString() }));
  return {
    ...base,
    assets: () => [...base.assets(), envAsset],
    incident: id => (id === '7' ? { incidentId: '7', title: 'Environmental excursion at Server closet: temperature 31.0 °C (limit 30.0 °C)', severity: 'high', status: 'open', scenarioType: 'environmental_excursion', initialAssetId: 'env-uno-r4-01', isSimulation: false, createdAt: '2026-11-08T01:00:40.000Z' } : undefined),
    impacts: id => (id === '7' ? [{ assetId: 'env-uno-r4-01', impactType: 'direct', impactStatus: 'degraded', peakStatus: 'degraded', depth: 0, causedByAssetId: null }] : []),
    evidence: id =>
      id === '7'
        ? [
            { evidenceId: '90', assetId: 'env-uno-r4-01', kind: 'environment', title: 'Temperature above limit', detail: 'Sensor uno-r4-01 (DHT11) measured 31.0 °C, at or above the 30.0 °C limit.', severity: 'medium', indicators: [{ key: 'temp_c', value: '31.0' }, { key: 'baseline_c', value: '23.5' }], observedAt: '2026-11-08T01:00:40.000Z', synthetic: false },
          ]
        : [],
    sensorNodeFor: assetId => (assetId === 'env-uno-r4-01' ? { nodeId: 'uno-r4-01', assetId, name: 'Server closet', sensorModel: 'DHT11', tempLimitC: 30, humidityLimitPct: 70, status: 'online' } : undefined),
    sensorReadings: nodeId => (nodeId === 'uno-r4-01' ? readings : []),
  };
}
