// Decodes scenario.json — rows produced by running the real SpacetimeDB module
// reducers in the module test harness (spacetime/scripts/export-scenario.test.ts).
// Test-only: never imported by the application bundle.
import { Identity, Timestamp } from 'spacetimedb';
import raw from './scenario.json';
import { deriveSentinelData, type SentinelData } from '../../hooks/useSentinelData';

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('__identity' in o) return Identity.fromString(o.__identity as string);
    if ('__ts' in o) return new Timestamp(BigInt(o.__ts as string));
    if ('__big' in o) return BigInt(o.__big as string);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, x === null ? undefined : decode(x)]));
  }
  return v;
}

export function loadScenario(): SentinelData {
  const d = raw as unknown as Record<string, unknown>;
  const rows = (k: string) => (decode(d[k] ?? []) as never);
  return deriveSentinelData(
    {
      ready: true,
      assets: rows('asset'),
      dependencies: rows('dependency'),
      incidents: rows('incident'),
      incidentAssets: rows('incidentAsset'),
      events: rows('incidentEvent'),
      tasks: rows('responseTask'),
      decisions: rows('incidentDecision'),
      messages: rows('incidentMessage'),
      recoveries: rows('recoveryAction'),
      audit: rows('auditEvent'),
      responders: rows('responder'),
      configs: rows('systemConfig'),
      aiInvestigations: rows('aiInvestigation'),
      aiFindings: rows('aiFinding'),
      aiSteps: rows('aiStep'),
      services: rows('servicePrincipal'),
      telemetry: rows('telemetrySample'),
      effects: rows('incidentEffect'),
      evidence: rows('incidentEvidence'),
      metrics: rows('telemetryMetric'),
      simulations: rows('simulationState'),
      sensorNodes: rows('sensorNode'),
      sensorReadings: rows('sensorReading'),
      proposals: rows('responseProposal'),
      explanations: rows('decisionExplanation'),
    },
    d.myIdentity as string
  );
}

export const scenarioIdentityHex = (raw as { myIdentity: string }).myIdentity;
