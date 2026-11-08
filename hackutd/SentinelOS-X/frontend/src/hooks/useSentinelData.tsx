// One subscription per table for the whole app. useTable owns subscription
// lifecycle (subscribe once, replay on reconnect, unsubscribe on unmount); the
// rows are shared through context so pages never create duplicate subscriptions
// and no authoritative state is copied into a separate store.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type {
  Asset,
  AuditEvent,
  Dependency,
  Incident,
  IncidentAsset,
  IncidentDecision,
  IncidentEvent,
  IncidentMessage,
  RecoveryAction,
  Responder,
  ResponseTask,
  SystemConfig,
  AiInvestigation,
  AiFinding,
  AiStep,
  ServicePrincipal,
  TelemetrySample,
  IncidentEffect,
  IncidentEvidence,
  TelemetryMetric,
  SimulationState,
  SensorNode,
  SensorReading,
  ResponseProposal,
  DecisionExplanation,
} from '../types/domain';

export interface SentinelData {
  ready: boolean;
  assets: readonly Asset[];
  dependencies: readonly Dependency[];
  incidents: readonly Incident[];
  incidentAssets: readonly IncidentAsset[];
  events: readonly IncidentEvent[];
  tasks: readonly ResponseTask[];
  decisions: readonly IncidentDecision[];
  messages: readonly IncidentMessage[];
  recoveries: readonly RecoveryAction[];
  audit: readonly AuditEvent[];
  responders: readonly Responder[];
  config: SystemConfig | undefined;
  aiInvestigations: readonly AiInvestigation[];
  aiFindings: readonly AiFinding[];
  aiSteps: readonly AiStep[];
  services: readonly ServicePrincipal[];
  telemetry: readonly TelemetrySample[];
  /** Samples per asset, oldest first. */
  telemetryByAsset: Map<string, TelemetrySample[]>;
  effects: readonly IncidentEffect[];
  evidence: readonly IncidentEvidence[];
  metrics: readonly TelemetryMetric[];
  simulation: SimulationState | undefined;
  /** Physical sensor nodes (REAL hardware) and their readings. */
  sensorNodes: readonly SensorNode[];
  sensorReadings: readonly SensorReading[];
  /** Decision Lab: shared response proposals and Nemotron explanations. */
  proposals: readonly ResponseProposal[];
  explanations: readonly DecisionExplanation[];
  /** Real readings per node, oldest first. */
  readingsByNode: Map<string, SensorReading[]>;
  /** Six-metric synthetic telemetry per asset, oldest first. */
  metricsByAsset: Map<string, TelemetryMetric[]>;
  /** Unresolved incidents impacting each asset (from incident_asset). */
  activeIncidentsByAsset: Map<string, bigint[]>;
  assetById: Map<string, Asset>;
  responderByHex: Map<string, Responder>;
  me: Responder | undefined;
  myHex: string | undefined;
}

export const SentinelDataContext = createContext<SentinelData | null>(null);
const Ctx = SentinelDataContext;

type Rows = Omit<SentinelData, 'assetById' | 'responderByHex' | 'me' | 'myHex' | 'config' | 'telemetryByAsset' | 'simulation' | 'metricsByAsset' | 'activeIncidentsByAsset' | 'readingsByNode'> & {
  configs: readonly SystemConfig[];
  simulations: readonly SimulationState[];
};

/** Pure: builds the context value (lookup maps, current responder) from subscribed rows. */
export function deriveSentinelData(rows: Rows, myHex: string | undefined): SentinelData {
  const { configs, simulations, ...rest } = rows;
  const assetById = new Map(rows.assets.map(a => [a.assetId, a]));
  const responderByHex = new Map(rows.responders.map(r => [r.identity.toHexString(), r]));
  const telemetryByAsset = new Map<string, TelemetrySample[]>();
  for (const s of [...rows.telemetry].sort((a, b) => (a.sampleId < b.sampleId ? -1 : 1))) {
    const list = telemetryByAsset.get(s.assetId);
    if (list) list.push(s);
    else telemetryByAsset.set(s.assetId, [s]);
  }
  const metricsByAsset = new Map<string, TelemetryMetric[]>();
  for (const m of [...rows.metrics].sort((a, b) => (a.metricId < b.metricId ? -1 : 1))) {
    const list = metricsByAsset.get(m.assetId);
    if (list) list.push(m);
    else metricsByAsset.set(m.assetId, [m]);
  }
  const readingsByNode = new Map<string, SensorReading[]>();
  for (const r of [...rows.sensorReadings].sort((a, b) => (a.readingId < b.readingId ? -1 : 1))) {
    const list = readingsByNode.get(r.nodeId);
    if (list) list.push(r);
    else readingsByNode.set(r.nodeId, [r]);
  }
  const unresolved = new Set(rows.incidents.filter(i => i.status !== 'resolved').map(i => i.incidentId));
  const activeIncidentsByAsset = new Map<string, bigint[]>();
  for (const ia of rows.incidentAssets) {
    if (ia.impactStatus === 'recovered' || !unresolved.has(ia.incidentId)) continue;
    const list = activeIncidentsByAsset.get(ia.assetId) ?? [];
    if (!list.includes(ia.incidentId)) list.push(ia.incidentId);
    activeIncidentsByAsset.set(ia.assetId, list);
  }
  return {
    ...rest,
    config: configs[0],
    simulation: simulations[0],
    assetById,
    responderByHex,
    telemetryByAsset,
    metricsByAsset,
    readingsByNode,
    activeIncidentsByAsset,
    me: myHex ? responderByHex.get(myHex) : undefined,
    myHex,
  };
}

export function SentinelDataProvider({ children }: { children: ReactNode }) {
  const { identity } = useSpacetimeDB();
  const [assets, r1] = useTable(tables.asset);
  const [dependencies, r2] = useTable(tables.dependency);
  const [incidents, r3] = useTable(tables.incident);
  const [incidentAssets, r4] = useTable(tables.incidentAsset);
  const [events, r5] = useTable(tables.incidentEvent);
  const [tasks, r6] = useTable(tables.responseTask);
  const [decisions, r7] = useTable(tables.incidentDecision);
  const [messages, r8] = useTable(tables.incidentMessage);
  const [recoveries, r9] = useTable(tables.recoveryAction);
  const [audit, r10] = useTable(tables.auditEvent);
  const [responders, r11] = useTable(tables.responder);
  const [configs, r12] = useTable(tables.systemConfig);
  const [aiInvestigations, r13] = useTable(tables.aiInvestigation);
  const [aiFindings, r14] = useTable(tables.aiFinding);
  const [aiSteps, r15] = useTable(tables.aiStep);
  const [services, r16] = useTable(tables.servicePrincipal);
  const [telemetry, r17] = useTable(tables.telemetrySample);
  const [effects, r18] = useTable(tables.incidentEffect);
  const [evidence, r19] = useTable(tables.incidentEvidence);
  const [metrics, r20] = useTable(tables.telemetryMetric);
  const [simulations, r21] = useTable(tables.simulationState);
  const [sensorNodes, r22] = useTable(tables.sensorNode);
  const [sensorReadings, r23] = useTable(tables.sensorReading);
  const [proposals, r24] = useTable(tables.responseProposal);
  const [explanations, r25] = useTable(tables.decisionExplanation);

  const ready = r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9 && r10 && r11 && r12 && r13 && r14 && r15 && r16 && r17 && r18 && r19 && r20 && r21 && r22 && r23 && r24 && r25;
  const myHex = identity?.toHexString();

  const value = useMemo<SentinelData>(
    () =>
      deriveSentinelData(
        { ready, assets, dependencies, incidents, incidentAssets, events, tasks, decisions, messages, recoveries, audit, responders, configs, aiInvestigations, aiFindings, aiSteps, services, telemetry, effects, evidence, metrics, simulations, sensorNodes, sensorReadings, proposals, explanations },
        myHex
      ),
    [ready, assets, dependencies, incidents, incidentAssets, events, tasks, decisions, messages, recoveries, audit, responders, configs, aiInvestigations, aiFindings, aiSteps, services, telemetry, effects, evidence, metrics, simulations, sensorNodes, sensorReadings, proposals, explanations, myHex]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSentinel(): SentinelData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSentinel must be used inside SentinelDataProvider');
  return v;
}
