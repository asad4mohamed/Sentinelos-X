// SentinelOS X — authoritative SpacetimeDB module (Phase 1).
//
// All infrastructure, incident, coordination and audit state lives here. Every
// mutation is a reducer; every reducer validates input and enforces roles
// server-side against the caller's SpacetimeDB identity (ctx.sender).
import { schema, t, table, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import { ScheduleAt } from 'spacetimedb';
import {
  computeBlastRadius,
  resolveEffect,
  severityFromBlast,
  CONTAINMENT,
  type AssetBlast,
  type Criticality,
  type DependencyType,
  type EffectInput,
  type EffectKind,
  type EffectPhase,
  type GraphEdge,
  type Severity,
} from './propagation';
import { generateMetrics } from './telemetry';
import * as v from './validation';
import { DEMO_ASSETS, DEMO_EDGES, LEGACY_SCENARIO, SCENARIOS, scenarioByType, scenarioEvidence, type EvidenceDraft } from './seed';
import * as sensor from './sensor';
import * as lab from './decisionLab';

// ───────────────────────────── Tables ─────────────────────────────

const MetaEntry = t.object('MetaEntry', { key: t.string(), value: t.string() });

const asset = table(
  { name: 'asset', public: true },
  {
    assetId: t.string().primaryKey(),
    name: t.string(),
    assetType: t.string(),
    environment: t.string(),
    criticality: t.string(), // low | medium | high | mission_critical
    description: t.string(),
    operationalStatus: t.string(), // online | degraded | offline
    healthStatus: t.string(), // healthy | degraded | critical | offline
    impactType: t.string(), // none | direct | cascade
    impactCausedBy: t.option(t.string()),
    directFailure: t.string(), // none | offline | degraded  (fault injected on this asset)
    directIncidentId: t.option(t.u64()),
    telemetrySource: t.string(), // 'synthetic' — simulated software telemetry, never live production data
    lastSeenAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const dependency = table(
  { name: 'dependency', public: true },
  {
    dependencyId: t.u64().primaryKey().autoInc(),
    dependentAssetId: t.string().index('btree'),
    requiredAssetId: t.string().index('btree'),
    dependencyType: t.string(), // required | noncritical | optional
    isCritical: t.bool(),
    rationale: t.string(),
  }
);

const incident = table(
  { name: 'incident', public: true },
  {
    incidentId: t.u64().primaryKey().autoInc(),
    title: t.string(),
    description: t.string(),
    severity: t.string(),
    status: t.string(),
    scenarioType: t.string(),
    initialAssetId: t.string(),
    isSimulation: t.bool(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    resolvedAt: t.option(t.timestamp()),
    resolutionSummary: t.option(t.string()),
  }
);

const incidentAsset = table(
  { name: 'incident_asset', public: true },
  {
    incidentAssetId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    assetId: t.string(),
    impactType: t.string(), // direct | cascade
    impactStatus: t.string(), // offline | degraded | recovered
    peakStatus: t.string(), // worst status observed: offline | degraded
    depth: t.u32(),
    causedByAssetId: t.option(t.string()),
    firstAffectedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const incidentEvent = table(
  { name: 'incident_event', public: true },
  {
    eventId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    eventType: t.string(),
    actor: t.option(t.identity()), // none = SentinelOS engine
    actorName: t.string(),
    description: t.string(),
    assetId: t.option(t.string()),
    timestamp: t.timestamp(),
    metadata: t.array(MetaEntry),
  }
);

const responseTask = table(
  { name: 'response_task', public: true },
  {
    taskId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    title: t.string(),
    status: t.string(),
    assignedTo: t.option(t.identity()),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    completedAt: t.option(t.timestamp()),
  }
);

const incidentDecision = table(
  { name: 'incident_decision', public: true },
  {
    decisionId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    summary: t.string(),
    rationale: t.string(),
    actor: t.identity(),
    actorName: t.string(),
    actorRole: t.string(),
    createdAt: t.timestamp(),
  }
);

const incidentMessage = table(
  { name: 'incident_message', public: true },
  {
    messageId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    sender: t.identity(),
    senderName: t.string(),
    senderRole: t.string(),
    body: t.string(),
    createdAt: t.timestamp(),
  }
);

const recoveryAction = table(
  { name: 'recovery_action', public: true },
  {
    recoveryId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    assetId: t.string(),
    plan: t.string(),
    status: t.string(), // pending | approved | rejected
    requestedBy: t.identity(),
    requestedAt: t.timestamp(),
    decidedBy: t.option(t.identity()),
    decidedAt: t.option(t.timestamp()),
    decisionNote: t.option(t.string()),
  }
);

const auditEvent = table(
  { name: 'audit_event', public: true },
  {
    auditId: t.u64().primaryKey().autoInc(),
    actor: t.option(t.identity()),
    actorName: t.string(),
    action: t.string(),
    targetType: t.string(),
    targetId: t.string(),
    timestamp: t.timestamp(),
    result: t.string(),
  }
);

const responder = table(
  { name: 'responder', public: true },
  {
    identity: t.identity().primaryKey(),
    displayName: t.string(),
    role: t.string(),
    online: t.bool(),
    registeredAt: t.timestamp(),
  }
);

const systemConfig = table(
  { name: 'system_config', public: true },
  {
    configId: t.u32().primaryKey(),
    environmentMode: t.string(), // 'development' in Phase 1
    devRoleSelfService: t.bool(),
    seededAt: t.timestamp(),
  }
);

// Non-human service identities (software telemetry generator, Nemotron agent).
// A service announces itself; only an Incident Commander can authorize it.
const servicePrincipal = table(
  { name: 'service_principal', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    kind: t.string(), // telemetry | ai_agent
    status: t.string(), // pending | authorized | revoked
    online: t.bool(),
    registeredAt: t.timestamp(),
    decidedBy: t.option(t.identity()),
    lastSeenAt: t.timestamp(),
  }
);

// Rolling window of SYNTHETIC software telemetry (latest 30 samples per asset).
const telemetrySample = table(
  { name: 'telemetry_sample', public: true },
  {
    sampleId: t.u64().primaryKey().autoInc(),
    assetId: t.string().index('btree'),
    latencyMs: t.f64(),
    errorRate: t.f64(), // 0..1
    cpuPct: t.f64(), // 0..100
    throughputRpm: t.f64(),
    timestamp: t.timestamp(),
  }
);

const TelemetryInput = t.object('TelemetryInput', {
  assetId: t.string(),
  latencyMs: t.f64(),
  errorRate: t.f64(),
  cpuPct: t.f64(),
  throughputRpm: t.f64(),
});

// AI investigations. Requested by humans; executed by an authorized ai_agent service.
const aiInvestigation = table(
  { name: 'ai_investigation', public: true },
  {
    investigationId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    status: t.string(), // requested | running | completed | failed
    requestedBy: t.identity(),
    requestedAt: t.timestamp(),
    agent: t.option(t.identity()),
    model: t.string(),
    startedAt: t.option(t.timestamp()),
    completedAt: t.option(t.timestamp()),
    summary: t.option(t.string()),
    error: t.option(t.string()),
  }
);

// Agent execution trace: every tool call (and model turn) the agent performed.
const aiStep = table(
  { name: 'ai_step', public: true },
  {
    stepId: t.u64().primaryKey().autoInc(),
    investigationId: t.u64().index('btree'),
    seq: t.u32(),
    kind: t.string(), // tool_call | model_message
    tool: t.option(t.string()),
    inputSummary: t.string(),
    outputSummary: t.string(),
    ok: t.bool(),
    timestamp: t.timestamp(),
  }
);

const aiFinding = table(
  { name: 'ai_finding', public: true },
  {
    findingId: t.u64().primaryKey().autoInc(),
    investigationId: t.u64().index('btree'),
    incidentId: t.u64().index('btree'),
    kind: t.string(), // finding | recommendation
    summary: t.string(),
    evidence: t.string(),
    assetId: t.option(t.string()),
    action: t.option(t.string()), // restore_asset (recommendations only)
    confidence: t.string(), // low | medium | high
    approvalStatus: t.string(), // not_required | pending | approved | rejected
    decidedBy: t.option(t.identity()),
    decidedAt: t.option(t.timestamp()),
    recoveryId: t.option(t.u64()),
    createdAt: t.timestamp(),
  }
);

// ═══════════════════ Phase 2 tables (additive — no existing table changed) ═══════════════════

// One row per (incident, root asset, effect kind). Asset health is DERIVED from
// all live effects, so overlapping incidents never mark a service healthy early.
const incidentEffect = table(
  { name: 'incident_effect', public: true },
  {
    effectId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    assetId: t.string().index('btree'),
    kind: t.string(), // outage | fault | overload | compromise | integrity
    level: t.string(), // offline | degraded (base operational level)
    phase: t.string(), // active | contained | recovering | cleared
    intensity: t.f64(), // overload escalation 0..1
    ticksInPhase: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    clearedAt: t.option(t.timestamp()),
  }
);

// Synthetic evidence (auth logs, file-integrity alerts, traffic metrics…).
const incidentEvidence = table(
  { name: 'incident_evidence', public: true },
  {
    evidenceId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    assetId: t.string(),
    kind: t.string(), // auth_log | db_health | traffic | file_integrity | containment
    title: t.string(),
    detail: t.string(),
    severity: t.string(), // info | low | medium | high | critical
    indicators: t.array(MetaEntry),
    observedAt: t.timestamp(),
    synthetic: t.bool(),
  }
);

// Six-metric SYNTHETIC telemetry, bounded to the latest METRIC_WINDOW per asset.
const telemetryMetric = table(
  { name: 'telemetry_metric', public: true },
  {
    metricId: t.u64().primaryKey().autoInc(),
    assetId: t.string().index('btree'),
    tick: t.u64(),
    cpuPct: t.f64(),
    memoryPct: t.f64(), // -1 = not reported (external source)
    requestRpm: t.f64(),
    errorRate: t.f64(),
    latencyMs: t.f64(),
    connections: t.f64(), // -1 = not reported (external source)
    source: t.string(), // simulation_engine | external
    timestamp: t.timestamp(),
  }
);

const simulationState = table(
  { name: 'simulation_state', public: true },
  {
    stateId: t.u32().primaryKey(),
    telemetryEnabled: t.bool(),
    tickCount: t.u64(),
    intervalMs: t.u32(),
    lastTickAt: t.option(t.timestamp()),
    startedAt: t.timestamp(),
  }
);

// ═══════════════════ Physical sensor gateway tables (REAL readings, not simulated) ═══════════════════

// One row per physical sensor node reporting through an authorized hardware_gateway service.
const sensorNode = table(
  { name: 'sensor_node', public: true },
  {
    nodeId: t.string().primaryKey(),
    assetId: t.string(), // the physical-environment asset this node measures
    name: t.string(),
    sensorModel: t.string(),
    tempLimitC: t.f64(),
    humidityLimitPct: t.f64(),
    status: t.string(), // online | silent
    lastReadingAt: t.option(t.timestamp()),
    breachStreak: t.u32(),
    calmStreak: t.u32(),
    activeIncidentId: t.option(t.u64()), // open environmental incident, if any
    silentIncidentId: t.option(t.u64()), // open "monitoring lost" incident, if any
    registeredAt: t.timestamp(),
  }
);

// Bounded rolling window of real readings per node.
const sensorReading = table(
  { name: 'sensor_reading', public: true },
  {
    readingId: t.u64().primaryKey().autoInc(),
    nodeId: t.string().index('btree'),
    tempC: t.f64(),
    humidityPct: t.f64(),
    timestamp: t.timestamp(),
  }
);

// ═══════════════════ Response Decision Lab (additive) ═══════════════════

// A responder's proposed response plan. The plan is evaluated by the deterministic
// Decision Lab engine on the SERVER at proposal time; `summary` is engine output,
// never model text. Adopting a plan executes nothing: steps still go through the
// existing containment / two-person recovery reducers.
const responseProposal = table(
  { name: 'response_proposal', public: true },
  {
    proposalId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    strategy: t.string(), // isolate | restore | failover | staged
    targetAssetId: t.string(),
    support: t.string(), // executable | hypothetical
    summary: t.string(),
    rationale: t.string(),
    stateFingerprint: t.string(),
    status: t.string(), // pending | adopted | rejected | withdrawn
    proposedBy: t.identity(),
    proposerName: t.string(),
    createdAt: t.timestamp(),
    decidedBy: t.option(t.identity()),
    decidedAt: t.option(t.timestamp()),
    decisionNote: t.option(t.string()),
  }
);

// Nemotron explanation of a Decision Lab comparison. The agent receives the
// engine's structured results and may only cite evidence ids of this incident.
const decisionExplanation = table(
  { name: 'decision_explanation', public: true },
  {
    explanationId: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    targetAssetId: t.string(),
    stateFingerprint: t.string(),
    status: t.string(), // requested | running | completed | failed
    requestedBy: t.identity(),
    requestedAt: t.timestamp(),
    agent: t.option(t.identity()),
    model: t.string(),
    text: t.option(t.string()),
    citedEvidence: t.array(t.u64()),
    error: t.option(t.string()),
    completedAt: t.option(t.timestamp()),
  }
);

// Private scheduler table driving simulation_tick.
const simulationSchedule = table(
  { name: 'simulation_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const spacetimedb = schema({
  asset,
  dependency,
  incident,
  incidentAsset,
  incidentEvent,
  responseTask,
  incidentDecision,
  incidentMessage,
  recoveryAction,
  auditEvent,
  responder,
  systemConfig,
  servicePrincipal,
  telemetrySample,
  aiInvestigation,
  aiStep,
  aiFinding,
  incidentEffect,
  incidentEvidence,
  telemetryMetric,
  sensorNode,
  sensorReading,
  simulationState,
  simulationSchedule,
  responseProposal,
  decisionExplanation,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Role = v.Role;
type Meta = { key: string; value: string };

const ENGINE = 'SentinelOS engine';

// ─────────────────────── Identity & permissions ───────────────────────

// Ticket controls (status, containment, recovery, resolve) are open to every
// registered responder regardless of role. Administration stays IC-only.
const ANY_RESPONDER = ['incident_commander', 'security_analyst', 'legal_responder', 'observer'] as const;

const PERMS = {
  launchSimulation: ['incident_commander', 'security_analyst'],
  injectFault: ['incident_commander', 'security_analyst'],
  contain: ANY_RESPONDER,
  updateIncidentStatus: ANY_RESPONDER,
  recordEvent: ['incident_commander', 'security_analyst', 'legal_responder'],
  createTask: ['incident_commander', 'security_analyst'],
  updateTask: ['incident_commander', 'security_analyst'],
  recordDecision: ['incident_commander', 'legal_responder'],
  sendMessage: ['incident_commander', 'security_analyst', 'legal_responder'],
  requestRecovery: ANY_RESPONDER,
  decideRecovery: ANY_RESPONDER,
  resolveIncident: ANY_RESPONDER,
  proposeResponse: ANY_RESPONDER,
  decideResponse: ANY_RESPONDER,
  administer: ['incident_commander'],
} as const satisfies Record<string, readonly Role[]>;

function requireResponder(ctx: Ctx) {
  const r = ctx.db.responder.identity.find(ctx.sender);
  if (!r) throw new SenderError('Unauthorized: register as a responder first');
  return r;
}

function requireRole(ctx: Ctx, allowed: readonly Role[], action: string) {
  const r = requireResponder(ctx);
  if (!(allowed as readonly string[]).includes(r.role)) {
    throw new SenderError(`Unauthorized: '${action}' requires role ${allowed.join(' or ')} (you are ${r.role})`);
  }
  return r;
}

function audit(ctx: Ctx, actorName: string, action: string, targetType: string, targetId: string, actor: Identity | undefined = ctx.sender) {
  ctx.db.auditEvent.insert({
    auditId: 0n,
    actor,
    actorName,
    action,
    targetType,
    targetId,
    timestamp: ctx.timestamp,
    result: 'success',
  });
}

function config(ctx: Ctx) {
  const c = ctx.db.systemConfig.configId.find(0);
  if (!c) throw new SenderError('System configuration missing; module not initialized');
  return c;
}

// ───────────────────────────── Helpers ─────────────────────────────

function event(
  ctx: Ctx,
  incidentId: bigint,
  eventType: string,
  description: string,
  opts: { actor?: Identity; actorName?: string; assetId?: string; metadata?: Meta[] } = {}
) {
  ctx.db.incidentEvent.insert({
    eventId: 0n,
    incidentId,
    eventType,
    actor: opts.actor,
    actorName: opts.actorName ?? ENGINE,
    description,
    assetId: opts.assetId,
    timestamp: ctx.timestamp,
    metadata: opts.metadata ?? [],
  });
}

function requireIncident(ctx: Ctx, incidentId: bigint) {
  const inc = ctx.db.incident.incidentId.find(incidentId);
  if (!inc) throw new SenderError(`Incident ${incidentId} not found`);
  return inc;
}

function requireOpenIncident(ctx: Ctx, incidentId: bigint) {
  const inc = requireIncident(ctx, incidentId);
  if (inc.status === 'resolved') throw new SenderError(`Incident ${incidentId} is resolved`);
  return inc;
}

function requireAsset(ctx: Ctx, assetId: string) {
  const a = ctx.db.asset.assetId.find(v.assetId(assetId));
  if (!a) throw new SenderError(`Asset '${assetId}' not found`);
  return a;
}

function touchIncident(ctx: Ctx, incidentId: bigint) {
  const inc = ctx.db.incident.incidentId.find(incidentId);
  if (inc) ctx.db.incident.incidentId.update({ ...inc, updatedAt: ctx.timestamp });
}

function seedInfrastructure(ctx: Ctx): { assets: number; edges: number } {
  let assets = 0;
  let edges = 0;
  for (const s of DEMO_ASSETS) {
    if (ctx.db.asset.assetId.find(s.assetId)) continue;
    ctx.db.asset.insert({
      ...s,
      operationalStatus: 'online',
      healthStatus: 'healthy',
      impactType: 'none',
      impactCausedBy: undefined,
      directFailure: 'none',
      directIncidentId: undefined,
      telemetrySource: 'synthetic',
      lastSeenAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    assets++;
  }
  const existing = new Set([...ctx.db.dependency.iter()].map(d => `${d.dependentAssetId}->${d.requiredAssetId}`));
  for (const e of DEMO_EDGES) {
    if (existing.has(`${e.dependent}->${e.required}`)) continue;
    ctx.db.dependency.insert({
      dependencyId: 0n,
      dependentAssetId: e.dependent,
      requiredAssetId: e.required,
      dependencyType: e.type,
      isCritical: e.type === 'required',
      rationale: e.rationale,
    });
    edges++;
  }
  return { assets, edges };
}

// ═══════════════════ Effects → derived twin state ═══════════════════

const RECOVERY_TICKS = 2;
const METRIC_WINDOW = 40;
const MAX_EVIDENCE_PER_INCIDENT = 24;
const TICK_INTERVAL_MS = 3000;

const IMPACT_RANK: Record<string, number> = { recovered: 0, recovering: 1, exposed: 2, degraded: 3, offline: 4 };

const ROOT_DESCRIPTION: Record<EffectKind, (name: string, level: string) => string> = {
  outage: n => `${n} unavailable — confirmed outage`,
  fault: (n, l) => `${n} directly failed (${l})`,
  overload: n => `${n} under abnormal synthetic load`,
  compromise: n => `${n} confirmed compromised (suspicious authentication activity)`,
  integrity: n => `${n} file-integrity violation confirmed`,
};

function graphEdges(ctx: Ctx): GraphEdge[] {
  return [...ctx.db.dependency.iter()].map(d => ({
    dependentAssetId: d.dependentAssetId,
    requiredAssetId: d.requiredAssetId,
    dependencyType: d.dependencyType as DependencyType,
  }));
}

type EffectRowLike = { effectId: bigint; incidentId: bigint; assetId: string; kind: string; level: string; phase: string; intensity: number };

function toInput(e: EffectRowLike): EffectInput {
  return { assetId: e.assetId, kind: e.kind as EffectKind, level: e.level === 'offline' ? 'offline' : 'degraded', phase: e.phase as EffectPhase, intensity: e.intensity };
}

function liveEffects(ctx: Ctx) {
  return [...ctx.db.incidentEffect.iter()].filter(e => e.phase !== 'cleared').sort((a, b) => (a.effectId < b.effectId ? -1 : 1));
}

function impactStatusOf(b: AssetBlast): string {
  if (b.health === 'recovering') return 'recovering';
  if (b.level !== 'healthy') return b.level;
  return 'exposed';
}

/**
 * Recompute the twin from all live incident effects and write only what changed:
 *  - asset rows: health / operational status / impact (global view, all incidents)
 *  - incident_asset rows: per-incident blast radius (each incident's own effects)
 *  - timeline events for every per-incident status change, in causal order
 *  - incident severity (deterministic rules)
 */
function applyPropagation(ctx: Ctx, actorName: string): void {
  const assets = [...ctx.db.asset.iter()];
  const byId = new Map(assets.map(a => [a.assetId, a]));
  const ids = assets.map(a => a.assetId);
  const edges = graphEdges(ctx);
  const effects = liveEffects(ctx);
  const global = computeBlastRadius(ids, edges, effects.map(toInput));

  // 1 ─ asset rows (global effective state)
  for (const b of global.values()) {
    const a = byId.get(b.assetId)!;
    const own = effects.filter(e => e.assetId === a.assetId && (e.phase === 'active' || e.phase === 'contained'));
    const ownLevels = own.map(e => resolveEffect(toInput(e))?.level ?? 'degraded');
    const directFailure = own.length === 0 ? 'none' : ownLevels.includes('offline') ? 'offline' : 'degraded';
    const directIncidentId = own[0]?.incidentId;
    const impactType = b.role === 'root' ? 'direct' : b.level !== 'healthy' ? 'cascade' : b.exposed ? 'exposed' : 'none';
    const impactCausedBy = b.role === 'root' ? undefined : (b.causedBy ?? b.exposureFrom ?? undefined);
    if (
      a.healthStatus !== b.health ||
      a.operationalStatus !== b.operationalStatus ||
      a.impactType !== impactType ||
      a.impactCausedBy !== impactCausedBy ||
      a.directFailure !== directFailure ||
      a.directIncidentId !== directIncidentId
    ) {
      ctx.db.asset.assetId.update({ ...a, healthStatus: b.health, operationalStatus: b.operationalStatus, impactType, impactCausedBy, directFailure, directIncidentId, updatedAt: ctx.timestamp });
    }
  }

  // 2 ─ per-incident blast radius
  const incidentIds = new Set<bigint>(effects.map(e => e.incidentId));
  for (const ia of ctx.db.incidentAsset.iter()) if (ia.impactStatus !== 'recovered') incidentIds.add(ia.incidentId);
  const critOf = (id: string) => (byId.get(id)?.criticality ?? 'low') as Criticality;

  for (const incidentId of [...incidentIds].sort((a, b) => (a < b ? -1 : 1))) {
    const inc = ctx.db.incident.incidentId.find(incidentId);
    if (!inc) continue;
    const mine = effects.filter(e => e.incidentId === incidentId);
    const blast = computeBlastRadius(ids, edges, mine.map(toInput));
    const rows = new Map([...ctx.db.incidentAsset.incidentId.filter(incidentId)].map(r => [r.assetId, r]));
    const impacted = [...blast.values()].filter(b => b.role !== 'none');
    const rank = (b: AssetBlast) => (b.role === 'root' ? 0 : b.level !== 'healthy' ? b.depth : 100 + b.depth);
    impacted.sort((x, y) => rank(x) - rank(y) || x.assetId.localeCompare(y.assetId));
    let changes = 0;

    for (const b of impacted) {
      const a = byId.get(b.assetId)!;
      const status = impactStatusOf(b);
      const prev = rows.get(b.assetId);
      const impactType = b.role === 'root' ? 'direct' : 'cascade';
      const causedBy = b.role === 'root' ? undefined : (b.causedBy ?? b.exposureFrom ?? undefined);
      const depth = b.role === 'root' ? 0 : b.level !== 'healthy' ? b.depth : (b.exposureDepth ?? b.depth);
      const peak = prev && IMPACT_RANK[prev.peakStatus] >= IMPACT_RANK[status] ? prev.peakStatus : status;
      if (!prev) {
        ctx.db.incidentAsset.insert({ incidentAssetId: 0n, incidentId, assetId: b.assetId, impactType, impactStatus: status, peakStatus: status, depth, causedByAssetId: causedBy, firstAffectedAt: ctx.timestamp, updatedAt: ctx.timestamp });
      } else if (prev.impactStatus !== status || prev.impactType !== impactType || prev.depth !== depth || prev.causedByAssetId !== causedBy || prev.peakStatus !== peak) {
        ctx.db.incidentAsset.incidentAssetId.update({ ...prev, impactType, impactStatus: status, peakStatus: peak, depth, causedByAssetId: causedBy, updatedAt: ctx.timestamp });
      }
      if (prev && prev.impactStatus === status) continue;
      changes++;
      const meta: Meta[] = [
        { key: 'previous_status', value: prev?.impactStatus ?? 'healthy' },
        { key: 'new_status', value: status },
        { key: 'impact_class', value: b.impactClass },
        { key: 'depth', value: String(depth) },
      ];
      if (causedBy) meta.push({ key: 'caused_by', value: causedBy });
      if (b.via) meta.push({ key: 'via', value: b.via });
      const cause = causedBy ? (byId.get(causedBy)?.name ?? causedBy) : '';
      if (b.role === 'root') {
        const kind = (mine.find(e => e.assetId === b.assetId)?.kind ?? 'fault') as EffectKind;
        meta.push({ key: 'effect', value: kind });
        if (status === 'recovering') event(ctx, incidentId, 'asset_recovering', `${a.name} recovering (simulated restoration in progress)`, { assetId: a.assetId, metadata: meta, actorName });
        else if (!prev || prev.impactStatus === 'recovered') event(ctx, incidentId, 'asset_failure_detected', ROOT_DESCRIPTION[kind](a.name, status), { assetId: a.assetId, metadata: meta, actorName });
        else event(ctx, incidentId, 'asset_status_changed', `${a.name} now ${status}`, { assetId: a.assetId, metadata: meta, actorName });
      } else if (status === 'offline') {
        event(ctx, incidentId, 'asset_marked_offline', `${a.name} unavailable: ${b.via} dependency on ${cause}`, { assetId: a.assetId, metadata: meta });
      } else if (status === 'degraded') {
        event(ctx, incidentId, 'asset_marked_degraded', `${a.name} degraded: ${b.via} dependency on ${cause}`, { assetId: a.assetId, metadata: meta });
      } else if (status === 'exposed') {
        event(ctx, incidentId, 'asset_exposed', `${a.name} potentially exposed: trusts ${cause} (hop ${depth}); not confirmed compromised`, { assetId: a.assetId, metadata: meta });
      } else {
        event(ctx, incidentId, 'asset_recovering', `${a.name} recovering as ${cause} restores`, { assetId: a.assetId, metadata: meta });
      }
    }

    const impactedIds = new Set(impacted.map(b => b.assetId));
    for (const r of [...rows.values()].sort((x, y) => x.assetId.localeCompare(y.assetId))) {
      if (impactedIds.has(r.assetId) || r.impactStatus === 'recovered') continue;
      changes++;
      ctx.db.incidentAsset.incidentAssetId.update({ ...r, impactStatus: 'recovered', updatedAt: ctx.timestamp });
      const a = byId.get(r.assetId);
      const still = global.get(r.assetId);
      const note = still && still.role !== 'none' ? ` (still impacted by another incident: ${still.health})` : '';
      event(ctx, incidentId, 'asset_restored', `${a?.name ?? r.assetId} no longer affected by this incident${note}`, {
        assetId: r.assetId,
        actorName,
        metadata: [{ key: 'previous_status', value: r.impactStatus }, { key: 'new_status', value: 'recovered' }],
      });
    }

    if (changes > 0) {
      const direct = impacted.filter(b => b.role === 'dependent' && b.depth === 1 && b.level !== 'healthy').length;
      const indirect = impacted.filter(b => b.role === 'dependent' && b.depth >= 2 && b.level !== 'healthy').length;
      const exposed = impacted.filter(b => b.role === 'dependent' && b.level === 'healthy' && b.exposed).length;
      const roots = impacted.filter(b => b.role === 'root').length;
      const maxDepth = impacted.reduce((m, b) => Math.max(m, b.level !== 'healthy' ? b.depth : (b.exposureDepth ?? 0)), 0);
      event(ctx, incidentId, 'dependency_impact_calculated', `Blast radius: ${impacted.length} affected — ${roots} root, ${direct} direct, ${indirect} indirect, ${exposed} potentially exposed (max depth ${maxDepth})`, {
        metadata: [
          { key: 'affected', value: String(impacted.length) },
          { key: 'root', value: String(roots) },
          { key: 'direct', value: String(direct) },
          { key: 'indirect', value: String(indirect) },
          { key: 'exposed', value: String(exposed) },
          { key: 'max_depth', value: String(maxDepth) },
        ],
      });
    }

    if (inc.status !== 'resolved') {
      // Severity tracks live impact; once everything recovers the incident keeps its last severity.
      const sev: Severity = impacted.length > 0 ? severityFromBlast(impacted, critOf) : (inc.severity as Severity);
      if (sev !== inc.severity) {
        event(ctx, incidentId, 'severity_updated', `Severity ${inc.severity} → ${sev}`, { metadata: [{ key: 'previous', value: inc.severity }, { key: 'new', value: sev }] });
      }
      if (sev !== inc.severity || changes > 0) ctx.db.incident.incidentId.update({ ...inc, severity: sev, updatedAt: ctx.timestamp });
    }
  }
}

function addEvidence(ctx: Ctx, incidentId: bigint, assetId: string, drafts: readonly EvidenceDraft[]): number {
  const existing = [...ctx.db.incidentEvidence.incidentId.filter(incidentId)].length;
  const room = Math.max(0, MAX_EVIDENCE_PER_INCIDENT - existing);
  const take = drafts.slice(0, room);
  for (const d of take) {
    ctx.db.incidentEvidence.insert({ evidenceId: 0n, incidentId, assetId, kind: d.kind, title: d.title, detail: d.detail, severity: d.severity, indicators: d.indicators, observedAt: ctx.timestamp, synthetic: true });
  }
  return take.length;
}

/** Phase 1 databases stored faults on asset rows; convert them into effects once. */
function migrateLegacyFaults(ctx: Ctx): number {
  let migrated = 0;
  const live = liveEffects(ctx);
  for (const a of [...ctx.db.asset.iter()]) {
    if (a.directFailure === 'none' || a.directIncidentId === undefined) continue;
    if (live.some(e => e.assetId === a.assetId)) continue;
    const inc = ctx.db.incident.incidentId.find(a.directIncidentId);
    if (!inc || inc.status === 'resolved') continue;
    ctx.db.incidentEffect.insert({ effectId: 0n, incidentId: inc.incidentId, assetId: a.assetId, kind: inc.scenarioType === LEGACY_SCENARIO.scenarioType && a.assetId === inc.initialAssetId ? 'outage' : 'fault', level: a.directFailure === 'offline' ? 'offline' : 'degraded', phase: 'active', intensity: 0, ticksInPhase: 0, createdAt: ctx.timestamp, updatedAt: ctx.timestamp, clearedAt: undefined });
    migrated++;
  }
  return migrated;
}

/** Idempotent: config, demo infrastructure, simulation state + scheduler, legacy migration. */
function ensureEnvironment(ctx: Ctx): { assets: number; edges: number; migrated: number } {
  if (!ctx.db.systemConfig.configId.find(0)) {
    ctx.db.systemConfig.insert({ configId: 0, environmentMode: 'development', devRoleSelfService: true, seededAt: ctx.timestamp });
  }
  const seeded = seedInfrastructure(ctx);
  if (!ctx.db.simulationState.stateId.find(0)) {
    ctx.db.simulationState.insert({ stateId: 0, telemetryEnabled: true, tickCount: 0n, intervalMs: TICK_INTERVAL_MS, lastTickAt: undefined, startedAt: ctx.timestamp });
  }
  if ([...ctx.db.simulationSchedule.iter()].length === 0) {
    ctx.db.simulationSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(BigInt(TICK_INTERVAL_MS) * 1000n) });
  }
  const migrated = migrateLegacyFaults(ctx);
  if (seeded.assets > 0 || seeded.edges > 0) {
    audit(ctx, ENGINE, 'seed_demo_infrastructure', 'environment', `${seeded.assets} assets, ${seeded.edges} dependencies added`, undefined);
  }
  if (seeded.assets > 0 || seeded.edges > 0 || migrated > 0) applyPropagation(ctx, ENGINE);
  return { ...seeded, migrated };
}

// ─────────────────────────── Lifecycle ───────────────────────────

export const init = spacetimedb.init(ctx => {
  ensureEnvironment(ctx);
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  // Brings existing databases up to date (new demo services, simulation engine,
  // Phase 1 fault migration). Idempotent; inserts only what is missing.
  ensureEnvironment(ctx);
  const r = ctx.db.responder.identity.find(ctx.sender);
  if (r && !r.online) ctx.db.responder.identity.update({ ...r, online: true });
  const sp = ctx.db.servicePrincipal.identity.find(ctx.sender);
  if (sp) ctx.db.servicePrincipal.identity.update({ ...sp, online: true, lastSeenAt: ctx.timestamp });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const r = ctx.db.responder.identity.find(ctx.sender);
  if (r && r.online) ctx.db.responder.identity.update({ ...r, online: false });
  const sp = ctx.db.servicePrincipal.identity.find(ctx.sender);
  if (sp && sp.online) ctx.db.servicePrincipal.identity.update({ ...sp, online: false, lastSeenAt: ctx.timestamp });
});

// ─────────────────────── Responders & roles ───────────────────────

export const register_responder = spacetimedb.reducer({ displayName: t.string() }, (ctx, { displayName }) => {
  const name = v.singleLine(displayName, 'Display name', 2, 40);
  if (ctx.db.servicePrincipal.identity.find(ctx.sender)) throw new SenderError('Service identities cannot register as responders');
  const existing = ctx.db.responder.identity.find(ctx.sender);
  if (existing) {
    ctx.db.responder.identity.update({ ...existing, displayName: name, online: true });
    audit(ctx, name, 'update_display_name', 'responder', ctx.sender.toHexString());
    return;
  }
  // Bootstrap: the first registered responder becomes Incident Commander.
  const hasCommander = [...ctx.db.responder.iter()].some(r => r.role === 'incident_commander');
  const role: Role = hasCommander ? 'observer' : 'incident_commander';
  ctx.db.responder.insert({ identity: ctx.sender, displayName: name, role, online: true, registeredAt: ctx.timestamp });
  audit(ctx, name, `register_responder:${role}`, 'responder', ctx.sender.toHexString());
});

export const assign_role = spacetimedb.reducer({ target: t.identity(), role: t.string() }, (ctx, { target, role }) => {
  const me = requireRole(ctx, PERMS.administer, 'assign_role');
  const newRole = v.oneOf(role, v.ROLES, 'role');
  const r = ctx.db.responder.identity.find(target);
  if (!r) throw new SenderError('Target responder not found');
  if (r.role === 'incident_commander' && newRole !== 'incident_commander') {
    const commanders = [...ctx.db.responder.iter()].filter(x => x.role === 'incident_commander').length;
    if (commanders <= 1) throw new SenderError('Cannot demote the last Incident Commander');
  }
  ctx.db.responder.identity.update({ ...r, role: newRole });
  audit(ctx, me.displayName, `assign_role:${newRole}`, 'responder', target.toHexString());
});

/** DEVELOPMENT ONLY: lets a registered responder pick their own role. Disabled by an IC via set_dev_role_self_service. */
export const dev_claim_role = spacetimedb.reducer({ role: t.string() }, (ctx, { role }) => {
  const me = requireResponder(ctx);
  if (!config(ctx).devRoleSelfService) throw new SenderError('Role self-service is disabled; ask an Incident Commander');
  const newRole = v.oneOf(role, v.ROLES, 'role');
  if (me.role === 'incident_commander' && newRole !== 'incident_commander') {
    const commanders = [...ctx.db.responder.iter()].filter(x => x.role === 'incident_commander').length;
    if (commanders <= 1) throw new SenderError('Cannot demote the last Incident Commander');
  }
  ctx.db.responder.identity.update({ ...me, role: newRole });
  audit(ctx, me.displayName, `dev_claim_role:${newRole}`, 'responder', ctx.sender.toHexString());
});

export const set_dev_role_self_service = spacetimedb.reducer({ enabled: t.bool() }, (ctx, { enabled }) => {
  const me = requireRole(ctx, PERMS.administer, 'set_dev_role_self_service');
  const c = config(ctx);
  ctx.db.systemConfig.configId.update({ ...c, devRoleSelfService: enabled });
  audit(ctx, me.displayName, `set_dev_role_self_service:${enabled}`, 'system_config', '0');
});

// ─────────────────────── Infrastructure ───────────────────────

/** Idempotent: inserts missing demo services/dependencies; never touches existing rows or incidents. */
export const seed_demo_infrastructure = spacetimedb.reducer(ctx => {
  const me = requireRole(ctx, PERMS.administer, 'seed_demo_infrastructure');
  const { assets, edges } = ensureEnvironment(ctx);
  audit(ctx, me.displayName, 'seed_demo_infrastructure', 'environment', `${assets} assets, ${edges} dependencies added`);
});

/**
 * Trusted simulation-controller operation: inject a synthetic fault on an asset
 * and re-run dependency propagation. Restoration is NOT possible here; it goes
 * through the human-approved recovery workflow.
 */
export const update_asset_status = spacetimedb.reducer(
  { assetId: t.string(), failure: t.string(), incidentId: t.u64(), reason: t.string() },
  (ctx, { assetId, failure, incidentId, reason }) => {
    const me = requireRole(ctx, PERMS.injectFault, 'update_asset_status');
    const mode = v.oneOf(failure, ['offline', 'degraded'] as const, 'failure');
    const why = v.singleLine(reason, 'Reason', 3, 200);
    const inc = requireOpenIncident(ctx, incidentId);
    if (!inc.isSimulation) throw new SenderError('Fault injection is only permitted on simulated incidents');
    const a = requireAsset(ctx, assetId);
    const dup = [...ctx.db.incidentEffect.assetId.filter(a.assetId)].find(e => e.incidentId === incidentId && e.kind === 'fault' && e.level === mode && e.phase !== 'cleared');
    if (dup) throw new SenderError(`${a.name} is already ${mode} under this incident`);
    ctx.db.incidentEffect.insert({ effectId: 0n, incidentId, assetId: a.assetId, kind: 'fault', level: mode, phase: 'active', intensity: 0, ticksInPhase: 0, createdAt: ctx.timestamp, updatedAt: ctx.timestamp, clearedAt: undefined });
    event(ctx, incidentId, 'fault_injected', `${me.displayName} injected a simulated ${mode} fault on ${a.name}: ${why}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      assetId: a.assetId,
      metadata: [{ key: 'failure', value: mode }],
    });
    applyPropagation(ctx, me.displayName);
    audit(ctx, me.displayName, `inject_fault:${mode}`, 'asset', a.assetId);
  }
);

// ─────────────────────────── Incidents ───────────────────────────

export const launch_simulated_incident = spacetimedb.reducer(
  { scenarioType: t.string(), title: t.string() },
  (ctx, { scenarioType, title }) => {
    const me = requireRole(ctx, PERMS.launchSimulation, 'launch_simulated_incident');
    const scen = scenarioByType(scenarioType);
    if (!scen) throw new SenderError(`Unknown scenario '${scenarioType}'. Available: ${SCENARIOS.map(x => x.scenarioType).join(', ')}`);
    const t0 = title.trim() === '' ? scen.defaultTitle : title;
    const cleanTitle = v.singleLine(t0, 'Incident title', 5, 120);
    const active = [...ctx.db.incident.iter()].find(i => i.scenarioType === scenarioType && i.status !== 'resolved');
    if (active) {
      throw new SenderError(`Simulation already active (incident #${active.incidentId}). Resolve it or reset the demo first.`);
    }
    const initial = requireAsset(ctx, scen.initialAssetId);

    const inc = ctx.db.incident.insert({
      incidentId: 0n,
      title: cleanTitle,
      description: scen.description,
      severity: 'low',
      status: 'open',
      scenarioType,
      initialAssetId: initial.assetId,
      isSimulation: true,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolutionSummary: undefined,
    });
    event(ctx, inc.incidentId, 'incident_created', `Simulated incident opened by ${me.displayName}: ${scen.label}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      metadata: [
        { key: 'scenario', value: scenarioType },
        { key: 'initial_asset', value: initial.assetId },
        { key: 'simulation', value: 'true' },
      ],
    });
    ctx.db.incidentEffect.insert({
      effectId: 0n,
      incidentId: inc.incidentId,
      assetId: initial.assetId,
      kind: scen.effectKind,
      level: scen.effectLevel,
      phase: 'active',
      intensity: scen.effectKind === 'overload' ? 0.4 : 0,
      ticksInPhase: 0,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      clearedAt: undefined,
    });
    const evidence = scenarioEvidence(scenarioType, () => ctx.random());
    const added = addEvidence(ctx, inc.incidentId, initial.assetId, evidence);
    if (added > 0) {
      event(ctx, inc.incidentId, 'evidence_collected', `${added} synthetic evidence item(s) collected from ${initial.name}`, {
        assetId: initial.assetId,
        metadata: [{ key: 'count', value: String(added) }, { key: 'kind', value: evidence[0]!.kind }],
      });
    }
    applyPropagation(ctx, ENGINE);
    audit(ctx, me.displayName, 'launch_simulated_incident', 'incident', String(inc.incidentId));
  }
);

/**
 * Simulated containment on a root asset: revoke sessions (compromise), rate
 * limiting (overload) or network isolation (file-integrity). Synthetic state only.
 */
export const apply_containment = spacetimedb.reducer(
  { incidentId: t.u64(), assetId: t.string() },
  (ctx, { incidentId, assetId }) => {
    const me = requireRole(ctx, PERMS.contain, 'apply_containment');
    const inc = requireOpenIncident(ctx, incidentId);
    const a = requireAsset(ctx, assetId);
    const mine = [...ctx.db.incidentEffect.assetId.filter(a.assetId)].filter(e => e.incidentId === incidentId && e.phase !== 'cleared');
    if (mine.length === 0) throw new SenderError(`${a.name} has no live effect under incident ${incidentId}`);
    const targets = mine.filter(e => e.phase === 'active' && CONTAINMENT[e.kind as EffectKind]);
    if (targets.length === 0) {
      const already = mine.some(e => e.phase === 'contained');
      throw new SenderError(already ? `${a.name} is already contained` : `No containment applies to ${a.name} (${mine[0]!.kind} effects recover directly)`);
    }
    const actions: string[] = [];
    for (const e of targets) {
      const c = CONTAINMENT[e.kind as EffectKind]!;
      actions.push(c.label);
      ctx.db.incidentEffect.effectId.update({ ...e, phase: 'contained', ticksInPhase: 0, updatedAt: ctx.timestamp });
      event(ctx, incidentId, 'containment_applied', `${me.displayName} contained ${a.name}: ${c.label} (simulated)`, {
        actor: ctx.sender,
        actorName: me.displayName,
        assetId: a.assetId,
        metadata: [{ key: 'action', value: c.action }, { key: 'effect', value: e.kind }],
      });
    }
    addEvidence(ctx, incidentId, a.assetId, [
      { kind: 'containment', title: 'Containment action executed (simulated)', detail: `${actions.join('; ')} on ${a.name} by ${me.displayName}. No real systems were changed.`, severity: 'info', indicators: [{ key: 'actor', value: me.displayName }] },
    ]);
    if (inc.status === 'open' || inc.status === 'investigating') {
      ctx.db.incident.incidentId.update({ ...inc, status: 'contained', updatedAt: ctx.timestamp });
      event(ctx, incidentId, 'status_changed', `Status ${inc.status} → contained (containment applied)`, { metadata: [{ key: 'previous', value: inc.status }, { key: 'new', value: 'contained' }] });
    }
    applyPropagation(ctx, me.displayName);
    audit(ctx, me.displayName, 'apply_containment', 'asset', a.assetId);
  }
);

export const update_incident_status = spacetimedb.reducer(
  { incidentId: t.u64(), status: t.string() },
  (ctx, { incidentId, status }) => {
    const me = requireRole(ctx, PERMS.updateIncidentStatus, 'update_incident_status');
    const inc = requireOpenIncident(ctx, incidentId);
    const to = v.oneOf(status, v.INCIDENT_STATUSES, 'status');
    v.incidentTransition(inc.status as v.IncidentStatus, to);
    ctx.db.incident.incidentId.update({ ...inc, status: to, updatedAt: ctx.timestamp });
    event(ctx, incidentId, 'status_changed', `Status ${inc.status} → ${to}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      metadata: [
        { key: 'previous', value: inc.status },
        { key: 'new', value: to },
      ],
    });
    audit(ctx, me.displayName, `update_incident_status:${to}`, 'incident', String(incidentId));
  }
);

export const record_incident_event = spacetimedb.reducer(
  { incidentId: t.u64(), description: t.string(), metadata: t.array(MetaEntry) },
  (ctx, { incidentId, description, metadata }) => {
    const me = requireRole(ctx, PERMS.recordEvent, 'record_incident_event');
    requireOpenIncident(ctx, incidentId);
    const desc = v.text(description, 'Event description', 3, 500);
    event(ctx, incidentId, 'note_added', desc, { actor: ctx.sender, actorName: me.displayName, metadata: v.metadata(metadata) });
    touchIncident(ctx, incidentId);
    audit(ctx, me.displayName, 'record_incident_event', 'incident', String(incidentId));
  }
);

export const resolve_incident = spacetimedb.reducer(
  { incidentId: t.u64(), summary: t.string() },
  (ctx, { incidentId, summary }) => {
    const me = requireRole(ctx, PERMS.resolveIncident, 'resolve_incident');
    const inc = requireOpenIncident(ctx, incidentId);
    const s = v.text(summary, 'Resolution summary', 5, 1000);
    const stillFailed = [...ctx.db.incidentEffect.incidentId.filter(incidentId)].filter(e => e.phase === 'active' || e.phase === 'contained');
    if (stillFailed.length > 0) {
      const names = [...new Set(stillFailed.map(e => ctx.db.asset.assetId.find(e.assetId)?.name ?? e.assetId))];
      throw new SenderError(`Cannot resolve: ${names.join(', ')} not yet recovered. Approve recovery actions first.`);
    }
    const pending = [...ctx.db.recoveryAction.incidentId.filter(incidentId)].filter(r => r.status === 'pending');
    if (pending.length > 0) throw new SenderError(`Cannot resolve: ${pending.length} recovery action(s) awaiting decision`);
    ctx.db.incident.incidentId.update({ ...inc, status: 'resolved', resolvedAt: ctx.timestamp, resolutionSummary: s, updatedAt: ctx.timestamp });
    event(ctx, incidentId, 'incident_resolved', `Incident resolved by ${me.displayName}: ${s}`, { actor: ctx.sender, actorName: me.displayName });
    audit(ctx, me.displayName, 'resolve_incident', 'incident', String(incidentId));
  }
);

// ─────────────────────── Response coordination ───────────────────────

export const create_response_task = spacetimedb.reducer(
  { incidentId: t.u64(), title: t.string(), assignee: t.option(t.identity()) },
  (ctx, { incidentId, title, assignee }) => {
    const me = requireRole(ctx, PERMS.createTask, 'create_response_task');
    requireOpenIncident(ctx, incidentId);
    const tt = v.singleLine(title, 'Task title', 3, 140);
    let assigneeName = 'unassigned';
    if (assignee) {
      const r = ctx.db.responder.identity.find(assignee);
      if (!r) throw new SenderError('Assignee is not a registered responder');
      if (r.role === 'observer') throw new SenderError('Observers cannot be assigned tasks');
      assigneeName = r.displayName;
    }
    const task = ctx.db.responseTask.insert({
      taskId: 0n,
      incidentId,
      title: tt,
      status: 'todo',
      assignedTo: assignee,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      completedAt: undefined,
    });
    event(ctx, incidentId, 'task_created', `Task #${task.taskId} created: ${tt} (${assigneeName})`, {
      actor: ctx.sender,
      actorName: me.displayName,
      metadata: [{ key: 'task_id', value: String(task.taskId) }],
    });
    touchIncident(ctx, incidentId);
    audit(ctx, me.displayName, 'create_response_task', 'response_task', String(task.taskId));
  }
);

export const update_response_task = spacetimedb.reducer(
  { taskId: t.u64(), status: t.string() },
  (ctx, { taskId, status }) => {
    const me = requireResponder(ctx);
    const task = ctx.db.responseTask.taskId.find(taskId);
    if (!task) throw new SenderError(`Task ${taskId} not found`);
    const isAssignee = task.assignedTo?.isEqual(ctx.sender) ?? false;
    if (!isAssignee && !(PERMS.updateTask as readonly string[]).includes(me.role)) {
      throw new SenderError('Unauthorized: only the assignee, an Incident Commander or a Security Analyst may update this task');
    }
    requireOpenIncident(ctx, task.incidentId);
    const to = v.oneOf(status, v.TASK_STATUSES, 'task status');
    v.taskTransition(task.status as v.TaskStatus, to);
    ctx.db.responseTask.taskId.update({
      ...task,
      status: to,
      updatedAt: ctx.timestamp,
      completedAt: to === 'done' ? ctx.timestamp : undefined,
    });
    event(ctx, task.incidentId, 'task_updated', `Task #${taskId} "${task.title}": ${task.status} → ${to}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      metadata: [
        { key: 'task_id', value: String(taskId) },
        { key: 'previous', value: task.status },
        { key: 'new', value: to },
      ],
    });
    touchIncident(ctx, task.incidentId);
    audit(ctx, me.displayName, `update_response_task:${to}`, 'response_task', String(taskId));
  }
);

export const record_incident_decision = spacetimedb.reducer(
  { incidentId: t.u64(), summary: t.string(), rationale: t.string() },
  (ctx, { incidentId, summary, rationale }) => {
    const me = requireRole(ctx, PERMS.recordDecision, 'record_incident_decision');
    requireOpenIncident(ctx, incidentId);
    const s = v.singleLine(summary, 'Decision summary', 3, 160);
    const r = v.text(rationale, 'Decision rationale', 3, 1000);
    const d = ctx.db.incidentDecision.insert({
      decisionId: 0n,
      incidentId,
      summary: s,
      rationale: r,
      actor: ctx.sender,
      actorName: me.displayName,
      actorRole: me.role,
      createdAt: ctx.timestamp,
    });
    event(ctx, incidentId, 'decision_recorded', `Decision: ${s}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      metadata: [{ key: 'decision_id', value: String(d.decisionId) }],
    });
    touchIncident(ctx, incidentId);
    audit(ctx, me.displayName, 'record_incident_decision', 'incident_decision', String(d.decisionId));
  }
);

export const send_incident_message = spacetimedb.reducer(
  { incidentId: t.u64(), body: t.string() },
  (ctx, { incidentId, body }) => {
    const me = requireRole(ctx, PERMS.sendMessage, 'send_incident_message');
    requireOpenIncident(ctx, incidentId);
    const b = v.text(body, 'Message', 1, 1000);
    // Basic flood control: max 10 messages per sender per incident within 10 s.
    const windowStart = ctx.timestamp.microsSinceUnixEpoch - 10_000_000n;
    const recent = [...ctx.db.incidentMessage.incidentId.filter(incidentId)].filter(
      m => m.sender.isEqual(ctx.sender) && m.createdAt.microsSinceUnixEpoch > windowStart
    ).length;
    if (recent >= 10) throw new SenderError('Rate limit: too many messages, slow down');
    ctx.db.incidentMessage.insert({
      messageId: 0n,
      incidentId,
      sender: ctx.sender,
      senderName: me.displayName,
      senderRole: me.role,
      body: b,
      createdAt: ctx.timestamp,
    });
  }
);

// ─────────────────────── Human-approved recovery ───────────────────────

function createRecoveryRequest(ctx: Ctx, requesterName: string, incidentId: bigint, assetId: string, plan: string) {
  requireOpenIncident(ctx, incidentId);
  const a = requireAsset(ctx, assetId);
  const live = [...ctx.db.incidentEffect.assetId.filter(a.assetId)].filter(e => e.incidentId === incidentId && (e.phase === 'active' || e.phase === 'contained'));
  if (live.length === 0) {
    throw new SenderError(`${a.name} has no unrecovered root-cause effect under incident ${incidentId}; recover the root cause instead`);
  }
  const uncontained = live.find(e => e.phase === 'active' && CONTAINMENT[e.kind as EffectKind]);
  if (uncontained) {
    throw new SenderError(`Contain ${a.name} first: ${CONTAINMENT[uncontained.kind as EffectKind]!.label}`);
  }
  const p = v.text(plan, 'Recovery plan', 5, 500);
  const dup = [...ctx.db.recoveryAction.incidentId.filter(incidentId)].find(r => r.assetId === a.assetId && r.status === 'pending');
  if (dup) throw new SenderError(`Recovery #${dup.recoveryId} for ${a.name} is already pending`);
  const r = ctx.db.recoveryAction.insert({
    recoveryId: 0n,
    incidentId,
    assetId: a.assetId,
    plan: p,
    status: 'pending',
    requestedBy: ctx.sender,
    requestedAt: ctx.timestamp,
    decidedBy: undefined,
    decidedAt: undefined,
    decisionNote: undefined,
  });
  event(ctx, incidentId, 'recovery_requested', `${requesterName} requested recovery of ${a.name}`, {
    actor: ctx.sender,
    actorName: requesterName,
    assetId: a.assetId,
    metadata: [{ key: 'recovery_id', value: String(r.recoveryId) }],
  });
  touchIncident(ctx, incidentId);
  audit(ctx, requesterName, 'request_recovery', 'recovery_action', String(r.recoveryId));
  return r;
}

export const request_recovery = spacetimedb.reducer(
  { incidentId: t.u64(), assetId: t.string(), plan: t.string() },
  (ctx, { incidentId, assetId, plan }) => {
    const me = requireRole(ctx, PERMS.requestRecovery, 'request_recovery');
    createRecoveryRequest(ctx, me.displayName, incidentId, assetId, plan);
  }
);

/** Approval requires a responder who is NOT the requester (two-person rule; any role may approve). */
export const decide_recovery = spacetimedb.reducer(
  { recoveryId: t.u64(), approve: t.bool(), note: t.string() },
  (ctx, { recoveryId, approve, note }) => {
    const me = requireRole(ctx, PERMS.decideRecovery, 'decide_recovery');
    const r = ctx.db.recoveryAction.recoveryId.find(recoveryId);
    if (!r) throw new SenderError(`Recovery action ${recoveryId} not found`);
    if (r.status !== 'pending') throw new SenderError(`Recovery action ${recoveryId} is already ${r.status}`);
    if (r.requestedBy.isEqual(ctx.sender)) {
      throw new SenderError('Two-person rule: the requester cannot approve or reject their own recovery action');
    }
    requireOpenIncident(ctx, r.incidentId);
    const n = v.text(note, 'Decision note', 0, 500);
    ctx.db.recoveryAction.recoveryId.update({
      ...r,
      status: approve ? 'approved' : 'rejected',
      decidedBy: ctx.sender,
      decidedAt: ctx.timestamp,
      decisionNote: n === '' ? undefined : n,
    });
    const a = requireAsset(ctx, r.assetId);
    event(ctx, r.incidentId, approve ? 'recovery_approved' : 'recovery_rejected', `${me.displayName} ${approve ? 'approved' : 'rejected'} recovery of ${a.name}${n ? `: ${n}` : ''}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      assetId: a.assetId,
      metadata: [{ key: 'recovery_id', value: String(recoveryId) }],
    });
    if (approve) {
      // Simulated restoration: this incident's effects on the asset enter the
      // 'recovering' phase; the simulation tick clears them after RECOVERY_TICKS.
      // Effects from OTHER incidents on the same asset are untouched.
      for (const e of [...ctx.db.incidentEffect.assetId.filter(a.assetId)]) {
        if (e.incidentId !== r.incidentId || (e.phase !== 'active' && e.phase !== 'contained')) continue;
        ctx.db.incidentEffect.effectId.update({ ...e, phase: 'recovering', ticksInPhase: 0, updatedAt: ctx.timestamp });
      }
      const inc = ctx.db.incident.incidentId.find(r.incidentId);
      if (inc && (inc.status === 'investigating' || inc.status === 'contained')) {
        ctx.db.incident.incidentId.update({ ...inc, status: 'recovering', updatedAt: ctx.timestamp });
        event(ctx, r.incidentId, 'status_changed', `Status ${inc.status} → recovering (recovery approved)`, { metadata: [{ key: 'previous', value: inc.status }, { key: 'new', value: 'recovering' }] });
      }
      applyPropagation(ctx, me.displayName);
    }
    touchIncident(ctx, r.incidentId);
    audit(ctx, me.displayName, approve ? 'approve_recovery' : 'reject_recovery', 'recovery_action', String(recoveryId));
  }
);

// ─────────────────────── Demo environment ───────────────────────

/**
 * Restore the synthetic environment. Never deletes records: active simulated
 * incidents are resolved with an explicit timeline entry instead.
 */
export const reset_demo_environment = spacetimedb.reducer(ctx => {
  const me = requireRole(ctx, PERMS.administer, 'reset_demo_environment');
  if (config(ctx).environmentMode !== 'development') throw new SenderError('Reset is only available in the development environment');
  for (const inc of [...ctx.db.incident.iter()]) {
    if (inc.status !== 'resolved' && !inc.isSimulation) {
      throw new SenderError(`Reset refused: non-simulated incident #${inc.incidentId} is active`);
    }
  }
  for (const e of liveEffects(ctx)) {
    ctx.db.incidentEffect.effectId.update({ ...e, phase: 'cleared', clearedAt: ctx.timestamp, updatedAt: ctx.timestamp });
  }
  applyPropagation(ctx, me.displayName);
  for (const r of [...ctx.db.recoveryAction.iter()]) {
    if (r.status === 'pending') {
      ctx.db.recoveryAction.recoveryId.update({ ...r, status: 'rejected', decidedBy: ctx.sender, decidedAt: ctx.timestamp, decisionNote: 'Cancelled by demo reset' });
    }
  }
  for (const inv of [...ctx.db.aiInvestigation.iter()]) {
    if (inv.status === 'requested' || inv.status === 'running') {
      ctx.db.aiInvestigation.investigationId.update({ ...inv, status: 'failed', error: 'Cancelled by demo reset', completedAt: ctx.timestamp });
    }
  }
  for (const f of [...ctx.db.aiFinding.iter()]) {
    if (f.approvalStatus === 'pending') ctx.db.aiFinding.findingId.update({ ...f, approvalStatus: 'rejected', decidedBy: ctx.sender, decidedAt: ctx.timestamp });
  }
  for (const p of [...ctx.db.responseProposal.iter()]) {
    if (p.status === 'pending') ctx.db.responseProposal.proposalId.update({ ...p, status: 'withdrawn', decidedBy: ctx.sender, decidedAt: ctx.timestamp, decisionNote: 'Cancelled by demo reset' });
  }
  for (const x of [...ctx.db.decisionExplanation.iter()]) {
    if (x.status === 'requested' || x.status === 'running') ctx.db.decisionExplanation.explanationId.update({ ...x, status: 'failed', error: 'Cancelled by demo reset', completedAt: ctx.timestamp });
  }
  for (const inc of [...ctx.db.incident.iter()]) {
    if (inc.status === 'resolved') continue;
    event(ctx, inc.incidentId, 'environment_reset', `${me.displayName} reset the demo environment; simulated incident closed`, {
      actor: ctx.sender,
      actorName: me.displayName,
    });
    ctx.db.incident.incidentId.update({
      ...inc,
      status: 'resolved',
      resolvedAt: ctx.timestamp,
      resolutionSummary: 'Closed by demo environment reset',
      updatedAt: ctx.timestamp,
    });
  }
  ensureEnvironment(ctx);
  audit(ctx, me.displayName, 'reset_demo_environment', 'environment', 'demo');
});

// ─────────────────────── Service principals ───────────────────────

const SERVICE_KINDS = ['telemetry', 'ai_agent', 'hardware_gateway'] as const;

function requireService(ctx: Ctx, kind: (typeof SERVICE_KINDS)[number]) {
  const sp = ctx.db.servicePrincipal.identity.find(ctx.sender);
  if (!sp || sp.kind !== kind) throw new SenderError(`Unauthorized: caller is not a registered ${kind} service`);
  if (sp.status !== 'authorized') throw new SenderError(`Unauthorized: service '${sp.name}' is ${sp.status}; an Incident Commander must authorize it`);
  return sp;
}

/** A service (telemetry generator, AI agent) announces itself. It starts 'pending' and cannot act until authorized. */
export const announce_service = spacetimedb.reducer({ name: t.string(), kind: t.string() }, (ctx, { name, kind }) => {
  const n = v.singleLine(name, 'Service name', 3, 60);
  const k = v.oneOf(kind, SERVICE_KINDS, 'service kind');
  if (ctx.db.responder.identity.find(ctx.sender)) throw new SenderError('Responder identities cannot register as services');
  const existing = ctx.db.servicePrincipal.identity.find(ctx.sender);
  if (existing) {
    if (existing.kind !== k) throw new SenderError(`Identity already registered as ${existing.kind}`);
    ctx.db.servicePrincipal.identity.update({ ...existing, name: n, online: true, lastSeenAt: ctx.timestamp });
    return;
  }
  ctx.db.servicePrincipal.insert({
    identity: ctx.sender,
    name: n,
    kind: k,
    status: 'pending',
    online: true,
    registeredAt: ctx.timestamp,
    decidedBy: undefined,
    lastSeenAt: ctx.timestamp,
  });
  audit(ctx, n, `announce_service:${k}`, 'service_principal', ctx.sender.toHexString());
});

export const authorize_service = spacetimedb.reducer({ target: t.identity(), authorize: t.bool() }, (ctx, { target, authorize }) => {
  const me = requireRole(ctx, PERMS.administer, 'authorize_service');
  const sp = ctx.db.servicePrincipal.identity.find(target);
  if (!sp) throw new SenderError('Service not found');
  const status = authorize ? 'authorized' : 'revoked';
  if (sp.status === status) throw new SenderError(`Service is already ${status}`);
  ctx.db.servicePrincipal.identity.update({ ...sp, status, decidedBy: ctx.sender });
  audit(ctx, me.displayName, `${authorize ? 'authorize' : 'revoke'}_service:${sp.kind}`, 'service_principal', target.toHexString());
});

// ─────────────────────── Synthetic software telemetry ───────────────────────

const TELEMETRY_WINDOW = 30;

function finite(n: number, field: string, min: number, max: number) {
  if (!Number.isFinite(n) || n < min || n > max) throw new SenderError(`${field} out of range [${min}, ${max}]`);
  return n;
}

/** Batch ingest from the authorized telemetry service. Telemetry never changes health: the twin stays deterministic. */
export const ingest_telemetry = spacetimedb.reducer({ samples: t.array(TelemetryInput) }, (ctx, { samples }) => {
  const sp = requireService(ctx, 'telemetry');
  if (ctx.db.simulationState.stateId.find(0)?.telemetryEnabled) {
    throw new SenderError('Built-in simulation engine is generating telemetry; disable it in Settings to use an external generator');
  }
  if (samples.length === 0 || samples.length > 64) throw new SenderError('Batch must contain 1–64 samples');
  const seen = new Set<string>();
  for (const s of samples) {
    const a = requireAsset(ctx, s.assetId);
    if (seen.has(a.assetId)) throw new SenderError(`Duplicate sample for ${a.assetId} in batch`);
    seen.add(a.assetId);
    ctx.db.telemetrySample.insert({
      sampleId: 0n,
      assetId: a.assetId,
      latencyMs: finite(s.latencyMs, 'latencyMs', 0, 600_000),
      errorRate: finite(s.errorRate, 'errorRate', 0, 1),
      cpuPct: finite(s.cpuPct, 'cpuPct', 0, 100),
      throughputRpm: finite(s.throughputRpm, 'throughputRpm', 0, 10_000_000),
      timestamp: ctx.timestamp,
    });
    ctx.db.telemetryMetric.insert({ metricId: 0n, assetId: a.assetId, tick: 0n, cpuPct: s.cpuPct, memoryPct: -1, requestRpm: s.throughputRpm, errorRate: s.errorRate, latencyMs: s.latencyMs, connections: -1, source: 'external', timestamp: ctx.timestamp });
    pruneMetrics(ctx, a.assetId);
    ctx.db.asset.assetId.update({ ...a, lastSeenAt: ctx.timestamp });
    const window = [...ctx.db.telemetrySample.assetId.filter(a.assetId)].sort((x, y) => (x.sampleId < y.sampleId ? -1 : 1));
    for (const old of window.slice(0, Math.max(0, window.length - TELEMETRY_WINDOW))) ctx.db.telemetrySample.sampleId.delete(old.sampleId);
  }
  ctx.db.servicePrincipal.identity.update({ ...sp, lastSeenAt: ctx.timestamp });
});

// ─────────────────────── AI investigations ───────────────────────

const AI_MAX_STEPS = 60;
const CONFIDENCES = ['low', 'medium', 'high'] as const;

function requireRunningInvestigation(ctx: Ctx, investigationId: bigint) {
  const inv = ctx.db.aiInvestigation.investigationId.find(investigationId);
  if (!inv) throw new SenderError(`Investigation ${investigationId} not found`);
  if (inv.status !== 'running') throw new SenderError(`Investigation ${investigationId} is ${inv.status}`);
  if (!inv.agent || !inv.agent.isEqual(ctx.sender)) throw new SenderError('Investigation is claimed by a different agent');
  return inv;
}

/** Human request for the AI agent to investigate an incident. */
export const request_ai_investigation = spacetimedb.reducer({ incidentId: t.u64() }, (ctx, { incidentId }) => {
  const me = requireRole(ctx, PERMS.requestRecovery, 'request_ai_investigation');
  requireOpenIncident(ctx, incidentId);
  const active = [...ctx.db.aiInvestigation.incidentId.filter(incidentId)].find(i => i.status === 'requested' || i.status === 'running');
  if (active) throw new SenderError(`Investigation #${active.investigationId} is already ${active.status}`);
  const inv = ctx.db.aiInvestigation.insert({
    investigationId: 0n,
    incidentId,
    status: 'requested',
    requestedBy: ctx.sender,
    requestedAt: ctx.timestamp,
    agent: undefined,
    model: '',
    startedAt: undefined,
    completedAt: undefined,
    summary: undefined,
    error: undefined,
  });
  event(ctx, incidentId, 'ai_investigation_requested', `${me.displayName} requested AI investigation #${inv.investigationId}`, {
    actor: ctx.sender,
    actorName: me.displayName,
    metadata: [{ key: 'investigation_id', value: String(inv.investigationId) }],
  });
  audit(ctx, me.displayName, 'request_ai_investigation', 'ai_investigation', String(inv.investigationId));
});

export const cancel_ai_investigation = spacetimedb.reducer({ investigationId: t.u64() }, (ctx, { investigationId }) => {
  const me = requireRole(ctx, PERMS.requestRecovery, 'cancel_ai_investigation');
  const inv = ctx.db.aiInvestigation.investigationId.find(investigationId);
  if (!inv) throw new SenderError(`Investigation ${investigationId} not found`);
  if (inv.status !== 'requested' && inv.status !== 'running') throw new SenderError(`Investigation is already ${inv.status}`);
  ctx.db.aiInvestigation.investigationId.update({ ...inv, status: 'failed', error: `Cancelled by ${me.displayName}`, completedAt: ctx.timestamp });
  audit(ctx, me.displayName, 'cancel_ai_investigation', 'ai_investigation', String(investigationId));
});

export const agent_claim_investigation = spacetimedb.reducer({ investigationId: t.u64(), model: t.string() }, (ctx, { investigationId, model }) => {
  const sp = requireService(ctx, 'ai_agent');
  const inv = ctx.db.aiInvestigation.investigationId.find(investigationId);
  if (!inv) throw new SenderError(`Investigation ${investigationId} not found`);
  if (inv.status !== 'requested') throw new SenderError(`Investigation ${investigationId} is ${inv.status}`);
  const m = v.singleLine(model, 'Model', 3, 120);
  ctx.db.aiInvestigation.investigationId.update({ ...inv, status: 'running', agent: ctx.sender, model: m, startedAt: ctx.timestamp });
  audit(ctx, sp.name, 'agent_claim_investigation', 'ai_investigation', String(investigationId));
});

export const agent_record_step = spacetimedb.reducer(
  { investigationId: t.u64(), kind: t.string(), tool: t.option(t.string()), inputSummary: t.string(), outputSummary: t.string(), ok: t.bool() },
  (ctx, { investigationId, kind, tool, inputSummary, outputSummary, ok }) => {
    requireService(ctx, 'ai_agent');
    requireRunningInvestigation(ctx, investigationId);
    const k = v.oneOf(kind, ['tool_call', 'model_message'] as const, 'step kind');
    const steps = [...ctx.db.aiStep.investigationId.filter(investigationId)];
    if (steps.length >= AI_MAX_STEPS) throw new SenderError(`Step limit (${AI_MAX_STEPS}) reached`);
    ctx.db.aiStep.insert({
      stepId: 0n,
      investigationId,
      seq: steps.length + 1,
      kind: k,
      tool: tool === undefined ? undefined : v.singleLine(tool, 'Tool name', 1, 60),
      inputSummary: v.text(inputSummary, 'Step input', 0, 1000),
      outputSummary: v.text(outputSummary, 'Step output', 0, 2000),
      ok,
      timestamp: ctx.timestamp,
    });
  }
);

export const agent_record_finding = spacetimedb.reducer(
  { investigationId: t.u64(), kind: t.string(), summary: t.string(), evidence: t.string(), assetId: t.option(t.string()), confidence: t.string() },
  (ctx, { investigationId, kind, summary, evidence, assetId, confidence }) => {
    requireService(ctx, 'ai_agent');
    const inv = requireRunningInvestigation(ctx, investigationId);
    const k = v.oneOf(kind, ['finding', 'recommendation'] as const, 'finding kind');
    const conf = v.oneOf(confidence, CONFIDENCES, 'confidence');
    let target: string | undefined;
    if (assetId !== undefined) target = requireAsset(ctx, assetId).assetId;
    if (k === 'recommendation') {
      // Phase 2 supports exactly one recommendable action: restoring a root-cause asset.
      const live = target ? [...ctx.db.incidentEffect.assetId.filter(target)].filter(e => e.incidentId === inv.incidentId && (e.phase === 'active' || e.phase === 'contained')) : [];
      if (live.length === 0) {
        throw new SenderError('Recommendations must target a root-cause (directly failed) asset of this incident');
      }
      const dup = [...ctx.db.aiFinding.investigationId.filter(investigationId)].find(f => f.kind === 'recommendation' && f.assetId === target);
      if (dup) throw new SenderError(`A recommendation for ${target} already exists in this investigation`);
    }
    ctx.db.aiFinding.insert({
      findingId: 0n,
      investigationId,
      incidentId: inv.incidentId,
      kind: k,
      summary: v.text(summary, 'Finding summary', 5, 500),
      evidence: v.text(evidence, 'Evidence', 0, 1500),
      assetId: target,
      action: k === 'recommendation' ? 'restore_asset' : undefined,
      confidence: conf,
      approvalStatus: k === 'recommendation' ? 'pending' : 'not_required',
      decidedBy: undefined,
      decidedAt: undefined,
      recoveryId: undefined,
      createdAt: ctx.timestamp,
    });
  }
);

export const agent_complete_investigation = spacetimedb.reducer(
  { investigationId: t.u64(), summary: t.string(), failed: t.bool() },
  (ctx, { investigationId, summary, failed }) => {
    const sp = requireService(ctx, 'ai_agent');
    const inv = requireRunningInvestigation(ctx, investigationId);
    const s = v.text(summary, failed ? 'Error' : 'Summary', 1, 2000);
    ctx.db.aiInvestigation.investigationId.update({
      ...inv,
      status: failed ? 'failed' : 'completed',
      summary: failed ? undefined : s,
      error: failed ? s : undefined,
      completedAt: ctx.timestamp,
    });
    const recs = [...ctx.db.aiFinding.investigationId.filter(investigationId)].filter(f => f.kind === 'recommendation').length;
    event(
      ctx,
      inv.incidentId,
      failed ? 'ai_investigation_failed' : 'ai_investigation_completed',
      failed ? `AI investigation #${investigationId} failed: ${s.slice(0, 200)}` : `AI investigation #${investigationId} completed with ${recs} recommendation(s) awaiting human review`,
      { actorName: `${sp.name} (${inv.model})`, metadata: [{ key: 'investigation_id', value: String(investigationId) }, { key: 'model', value: inv.model }] }
    );
    audit(ctx, sp.name, failed ? 'agent_fail_investigation' : 'agent_complete_investigation', 'ai_investigation', String(investigationId));
  }
);

/**
 * Human decision on an AI recommendation. Approval does NOT restore anything:
 * it files a normal recovery request under the approving human's identity,
 * which still needs a second Incident Commander (two-person rule).
 */
export const decide_ai_recommendation = spacetimedb.reducer(
  { findingId: t.u64(), approve: t.bool() },
  (ctx, { findingId, approve }) => {
    const me = requireRole(ctx, PERMS.requestRecovery, 'decide_ai_recommendation');
    const f = ctx.db.aiFinding.findingId.find(findingId);
    if (!f) throw new SenderError(`Finding ${findingId} not found`);
    if (f.kind !== 'recommendation') throw new SenderError('Only recommendations require a decision');
    if (f.approvalStatus !== 'pending') throw new SenderError(`Recommendation is already ${f.approvalStatus}`);
    let recoveryId: bigint | undefined;
    if (approve) {
      const r = createRecoveryRequest(ctx, me.displayName, f.incidentId, f.assetId ?? '', `AI-recommended (finding #${findingId}): ${f.summary}`.slice(0, 500));
      recoveryId = r.recoveryId;
    }
    ctx.db.aiFinding.findingId.update({ ...f, approvalStatus: approve ? 'approved' : 'rejected', decidedBy: ctx.sender, decidedAt: ctx.timestamp, recoveryId });
    event(ctx, f.incidentId, 'ai_recommendation_decided', `${me.displayName} ${approve ? 'accepted' : 'rejected'} AI recommendation #${findingId}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      assetId: f.assetId,
      metadata: [{ key: 'finding_id', value: String(findingId) }, ...(recoveryId !== undefined ? [{ key: 'recovery_id', value: String(recoveryId) }] : [])],
    });
    audit(ctx, me.displayName, `${approve ? 'approve' : 'reject'}_ai_recommendation`, 'ai_finding', String(findingId));
  }
);

// ═══════════════════ Simulation engine (scheduled) ═══════════════════

function pruneMetrics(ctx: Ctx, assetId: string) {
  const rows = [...ctx.db.telemetryMetric.assetId.filter(assetId)];
  if (rows.length <= METRIC_WINDOW) return;
  rows.sort((x, y) => (x.metricId < y.metricId ? -1 : 1));
  for (const old of rows.slice(0, rows.length - METRIC_WINDOW)) ctx.db.telemetryMetric.metricId.delete(old.metricId);
}

const PERIODIC_EVIDENCE: Partial<Record<EffectKind, (assetName: string, rand: () => number) => EvidenceDraft>> = {
  overload: (n, rand) => ({ kind: 'traffic', title: 'Sustained surge', detail: `${n}: request rate remains ${(6 + rand() * 6).toFixed(1)}× baseline.`, severity: 'medium', indicators: [{ key: 'window', value: '15s' }] }),
  compromise: (n, rand) => ({ kind: 'auth_log', title: 'Continued credential attempts', detail: `${n}: ${200 + Math.floor(rand() * 400)} additional failed sign-ins in the last 15 s.`, severity: 'medium', indicators: [{ key: 'window', value: '15s' }] }),
  integrity: (n, rand) => ({ kind: 'file_integrity', title: 'Encryption activity continuing', detail: `${n}: ${300 + Math.floor(rand() * 500)} more files modified with high entropy.`, severity: 'high', indicators: [{ key: 'window', value: '15s' }] }),
};

/** One simulation step (called only from the scheduled simulation_tick reducer). */
function runTick(ctx: Ctx) {
  const st = ctx.db.simulationState.stateId.find(0);
  if (!st) return;
  const tick = st.tickCount + 1n;
  let structural = false;

  for (const e of liveEffects(ctx)) {
    const next = { ...e, ticksInPhase: e.ticksInPhase + 1, updatedAt: ctx.timestamp };
    if (e.phase === 'recovering' && next.ticksInPhase >= RECOVERY_TICKS) {
      next.phase = 'cleared';
      next.clearedAt = ctx.timestamp;
      structural = true;
    }
    if (e.kind === 'overload' && e.phase === 'active') {
      next.intensity = Math.min(1, Math.round((e.intensity + 0.2) * 100) / 100);
      if (e.intensity < 1 && next.intensity >= 1) {
        structural = true;
        const a = ctx.db.asset.assetId.find(e.assetId);
        event(ctx, e.incidentId, 'surge_escalated', `${a?.name ?? e.assetId} saturated: synthetic load exceeded capacity — apply rate limiting`, { assetId: e.assetId, metadata: [{ key: 'intensity', value: '1.0' }] });
      }
    } else if (e.kind === 'overload' && e.phase === 'contained') {
      next.intensity = Math.max(0.2, Math.round((e.intensity - 0.2) * 100) / 100);
    }
    ctx.db.incidentEffect.effectId.update(next);
    const periodic = PERIODIC_EVIDENCE[e.kind as EffectKind];
    if (periodic && e.phase === 'active' && next.ticksInPhase % 5 === 0) {
      const a = ctx.db.asset.assetId.find(e.assetId);
      addEvidence(ctx, e.incidentId, e.assetId, [periodic(a?.name ?? e.assetId, () => ctx.random())]);
    }
  }
  if (structural) applyPropagation(ctx, ENGINE);

  if (st.telemetryEnabled) {
    const live = liveEffects(ctx);
    for (const a of [...ctx.db.asset.iter()]) {
      if (a.telemetrySource === 'physical_sensor') continue; // real hardware: never generate synthetic metrics for it
      const root = live.filter(e => e.assetId === a.assetId).sort((x, y) => (resolveEffect(toInput(y))?.rootHealth === 'critical' ? 1 : 0) - (resolveEffect(toInput(x))?.rootHealth === 'critical' ? 1 : 0))[0];
      const m = generateMetrics(
        { assetId: a.assetId, assetType: a.assetType, health: a.healthStatus as AssetBlast['health'], operationalStatus: a.operationalStatus, rootKind: root?.kind as EffectKind | undefined, rootPhase: root?.phase as EffectPhase | undefined, intensity: root?.intensity },
        () => ctx.random(),
        Number(tick)
      );
      ctx.db.telemetryMetric.insert({ metricId: 0n, assetId: a.assetId, tick, ...m, source: 'simulation_engine', timestamp: ctx.timestamp });
      pruneMetrics(ctx, a.assetId);
      // Mirror to the Phase 1 telemetry table so existing consumers keep working.
      ctx.db.telemetrySample.insert({ sampleId: 0n, assetId: a.assetId, latencyMs: m.latencyMs, errorRate: m.errorRate, cpuPct: m.cpuPct, throughputRpm: m.requestRpm, timestamp: ctx.timestamp });
      const window = [...ctx.db.telemetrySample.assetId.filter(a.assetId)].sort((x, y) => (x.sampleId < y.sampleId ? -1 : 1));
      for (const old of window.slice(0, Math.max(0, window.length - TELEMETRY_WINDOW))) ctx.db.telemetrySample.sampleId.delete(old.sampleId);
    }
  }
  ctx.db.simulationState.stateId.update({ ...st, tickCount: tick, lastTickAt: ctx.timestamp });
}

export const simulation_tick = spacetimedb.reducer({ onSchedule: simulationSchedule }, { timer: simulationSchedule.rowType }, (ctx, { timer }) => {
  if (!ctx.senderAuth.isInternal) throw new SenderError('simulation_tick may only be invoked by the scheduler');
  void timer;
  runTick(ctx);
});

/** IC-only: toggle built-in synthetic telemetry (incident progression always continues). */
export const set_simulation_engine = spacetimedb.reducer({ telemetryEnabled: t.bool() }, (ctx, { telemetryEnabled }) => {
  const me = requireRole(ctx, PERMS.administer, 'set_simulation_engine');
  const st = ctx.db.simulationState.stateId.find(0);
  if (!st) throw new SenderError('Simulation engine not initialized');
  ctx.db.simulationState.stateId.update({ ...st, telemetryEnabled });
  audit(ctx, me.displayName, `set_simulation_engine:${telemetryEnabled ? 'on' : 'off'}`, 'simulation_state', '0');
});

// ═══════════════════ Physical sensor gateway (REAL readings, not simulated) ═══════════════════
//
// An authorized `hardware_gateway` service reports readings from a physical sensor node. The module
// itself detects excursions from those readings and opens a REAL (isSimulation = false) incident whose
// evidence is the measured data (synthetic = false). The twin's predicted impact on dependent services
// is MODELED (see the edge rationale), not measured. Authorization is enforced here, not by the device.

const SENSOR_KEEP = 600; // readings retained per node
const SENSOR_HISTORY = 40; // readings considered by detection
const ENV_SCENARIO = 'environmental_excursion';
const SILENT_SCENARIO = 'sensor_silent';

interface NodeRef {
  nodeId: string;
  name: string;
  assetId: string;
  sensorModel: string;
}

function sensorHistory(ctx: Ctx, nodeId: string): sensor.Reading[] {
  return [...ctx.db.sensorReading.nodeId.filter(nodeId)]
    .sort((a, b) => (a.readingId < b.readingId ? -1 : 1))
    .slice(-SENSOR_HISTORY)
    .map(r => ({ tempC: r.tempC, humidityPct: r.humidityPct, atMs: Number(r.timestamp.microsSinceUnixEpoch / 1000n) }));
}

function incidentIsOpen(ctx: Ctx, id: bigint | undefined): boolean {
  if (id === undefined) return false;
  const inc = ctx.db.incident.incidentId.find(id);
  return !!inc && inc.status !== 'resolved';
}

/** An already-open REAL (non-simulated) incident rooted at this asset, if any. New sensor tickets attach to it instead of duplicating. */
function openRealIncidentForAsset(ctx: Ctx, assetId: string) {
  return [...ctx.db.incident.iter()].find(i => !i.isSimulation && i.status !== 'resolved' && i.initialAssetId === assetId);
}

/** Like addEvidence, but for measured data: synthetic = false. */
function addRealEvidence(ctx: Ctx, incidentId: bigint, assetId: string, drafts: readonly EvidenceDraft[]): number {
  const existing = [...ctx.db.incidentEvidence.incidentId.filter(incidentId)].length;
  const take = drafts.slice(0, Math.max(0, MAX_EVIDENCE_PER_INCIDENT - existing));
  for (const d of take) {
    ctx.db.incidentEvidence.insert({ evidenceId: 0n, incidentId, assetId, kind: d.kind, title: d.title, detail: d.detail, severity: d.severity, indicators: d.indicators, observedAt: ctx.timestamp, synthetic: false });
  }
  return take.length;
}

function requestInvestigationFor(ctx: Ctx, incidentId: bigint, requesterName: string) {
  const active = [...ctx.db.aiInvestigation.incidentId.filter(incidentId)].find(i => i.status === 'requested' || i.status === 'running');
  if (active) return;
  const inv = ctx.db.aiInvestigation.insert({ investigationId: 0n, incidentId, status: 'requested', requestedBy: ctx.sender, requestedAt: ctx.timestamp, agent: undefined, model: '', startedAt: undefined, completedAt: undefined, summary: undefined, error: undefined });
  event(ctx, incidentId, 'ai_investigation_requested', `${requesterName} requested AI investigation #${inv.investigationId}`, {
    actor: ctx.sender,
    actorName: requesterName,
    metadata: [{ key: 'investigation_id', value: String(inv.investigationId) }],
  });
}

function openEnvironmentalIncident(ctx: Ctx, actorName: string, node: NodeRef, breaches: sensor.Breach[], history: sensor.Reading[]): bigint {
  const asset = requireAsset(ctx, node.assetId);
  const summary = sensor.summarize(breaches);
  const inc = ctx.db.incident.insert({
    incidentId: 0n,
    title: v.singleLine(`Environmental excursion at ${node.name}: ${summary}`.slice(0, 120), 'Incident title', 5, 120),
    description: `REAL EVENT: physical sensor ${node.nodeId} (${node.sensorModel}) reported readings outside its configured limits. The readings and evidence are measured, not simulated. The predicted impact on dependent services is MODELED by the digital twin, not measured.`,
    severity: 'low',
    status: 'open',
    scenarioType: ENV_SCENARIO,
    initialAssetId: asset.assetId,
    isSimulation: false,
    createdBy: ctx.sender,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    resolvedAt: undefined,
    resolutionSummary: undefined,
  });
  event(ctx, inc.incidentId, 'incident_created', `Real environmental incident opened from sensor ${node.nodeId}: ${summary}`, {
    actor: ctx.sender,
    actorName,
    metadata: [
      { key: 'scenario', value: ENV_SCENARIO },
      { key: 'source', value: 'physical_sensor' },
      { key: 'simulation', value: 'false' },
      { key: 'node', value: node.nodeId },
    ],
  });
  ctx.db.incidentEffect.insert({ effectId: 0n, incidentId: inc.incidentId, assetId: asset.assetId, kind: 'fault', level: 'degraded', phase: 'active', intensity: 0, ticksInPhase: 0, createdAt: ctx.timestamp, updatedAt: ctx.timestamp, clearedAt: undefined });
  const added = addRealEvidence(ctx, inc.incidentId, asset.assetId, sensor.buildEvidence(node.nodeId, node.sensorModel, breaches, history));
  event(ctx, inc.incidentId, 'evidence_collected', `${added} measured evidence item(s) recorded from sensor ${node.nodeId}`, {
    assetId: asset.assetId,
    actorName,
    metadata: [{ key: 'count', value: String(added) }, { key: 'kind', value: 'environment' }, { key: 'synthetic', value: 'false' }],
  });
  applyPropagation(ctx, actorName);
  requestInvestigationFor(ctx, inc.incidentId, actorName);
  audit(ctx, actorName, 'open_environmental_incident', 'incident', String(inc.incidentId));
  return inc.incidentId;
}

/** Gateway registers (or updates) a physical sensor node and its twin asset. Idempotent. */
export const register_sensor_node = spacetimedb.reducer(
  { nodeId: t.string(), name: t.string(), tempLimitC: t.f64(), humidityLimitPct: t.f64() },
  (ctx, { nodeId, name, tempLimitC, humidityLimitPct }) => {
    const sp = requireService(ctx, 'hardware_gateway');
    const id = v.assetId(nodeId);
    const n = v.singleLine(name, 'Node name', 3, 60);
    const bad = sensor.validateLimits({ tempLimitC, humidityLimitPct });
    if (bad) throw new SenderError(bad);
    const assetKey = v.assetId(`env-${id}`);
    if (!ctx.db.asset.assetId.find(assetKey)) {
      ctx.db.asset.insert({
        assetId: assetKey,
        name: `${n} (environment)`,
        assetType: 'environment_sensor',
        environment: 'physical',
        criticality: 'high',
        description: `Physical environment measured by a real DHT11 sensor (node ${id}). Readings are real, not simulated.`,
        operationalStatus: 'online',
        healthStatus: 'healthy',
        impactType: 'none',
        impactCausedBy: undefined,
        directFailure: 'none',
        directIncidentId: undefined,
        telemetrySource: 'physical_sensor',
        lastSeenAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }
    // MODELED consequence edge (not measured): the primary database is assumed to be racked in the monitored closet.
    if (ctx.db.asset.assetId.find('primary-db') && ![...ctx.db.dependency.dependentAssetId.filter('primary-db')].some(d => d.requiredAssetId === assetKey)) {
      ctx.db.dependency.insert({
        dependencyId: 0n,
        dependentAssetId: 'primary-db',
        requiredAssetId: assetKey,
        dependencyType: 'required',
        isCritical: true,
        rationale: 'MODELED, not measured: the primary database host is assumed to be racked in the monitored closet, so a thermal excursion there degrades it.',
      });
    }
    const existing = ctx.db.sensorNode.nodeId.find(id);
    if (existing) {
      ctx.db.sensorNode.nodeId.update({ ...existing, name: n, tempLimitC, humidityLimitPct });
    } else {
      ctx.db.sensorNode.insert({ nodeId: id, assetId: assetKey, name: n, sensorModel: 'DHT11', tempLimitC, humidityLimitPct, status: 'online', lastReadingAt: undefined, breachStreak: 0, calmStreak: 0, activeIncidentId: undefined, silentIncidentId: undefined, registeredAt: ctx.timestamp });
    }
    audit(ctx, sp.name, existing ? 'update_sensor_node' : 'register_sensor_node', 'sensor_node', id);
  }
);

/** One real reading. The module validates it, stores a bounded window, and detects excursions server-side. */
export const ingest_sensor_reading = spacetimedb.reducer(
  { nodeId: t.string(), tempC: t.f64(), humidityPct: t.f64() },
  (ctx, { nodeId, tempC, humidityPct }) => {
    const sp = requireService(ctx, 'hardware_gateway');
    const node = ctx.db.sensorNode.nodeId.find(nodeId);
    if (!node) throw new SenderError(`Sensor node '${nodeId.slice(0, 48)}' is not registered`);
    const bad = sensor.validateReading(tempC, humidityPct);
    if (bad) throw new SenderError(bad);

    ctx.db.sensorReading.insert({ readingId: 0n, nodeId, tempC, humidityPct, timestamp: ctx.timestamp });
    const all = [...ctx.db.sensorReading.nodeId.filter(nodeId)].sort((a, b) => (a.readingId < b.readingId ? -1 : 1));
    for (const old of all.slice(0, Math.max(0, all.length - SENSOR_KEEP))) ctx.db.sensorReading.readingId.delete(old.readingId);

    const history = sensorHistory(ctx, nodeId);
    const latest = history[history.length - 1]!;
    const lim = { tempLimitC: node.tempLimitC, humidityLimitPct: node.humidityLimitPct };
    const breaches = sensor.detectBreaches(history, lim);
    const breachStreak = breaches.length > 0 ? node.breachStreak + 1 : 0;
    const calmStreak = sensor.isCalm(latest, lim) ? node.calmStreak + 1 : 0;
    let activeIncidentId = incidentIsOpen(ctx, node.activeIncidentId) ? node.activeIncidentId : undefined;

    if (node.status === 'silent' && incidentIsOpen(ctx, node.silentIncidentId)) {
      event(ctx, node.silentIncidentId!, 'sensor_back_online', `${node.name} resumed reporting (${latest.tempC.toFixed(1)} °C, ${latest.humidityPct.toFixed(0)}%)`, {
        actorName: sp.name,
        assetId: node.assetId,
        metadata: [{ key: 'node', value: node.nodeId }],
      });
    }

    if (breaches.length > 0 && breachStreak >= sensor.BREACH_STREAK_TO_OPEN && activeIncidentId === undefined) {
      // Never open a second ticket while an older real incident for this asset is still open: attach to it.
      const existing = openRealIncidentForAsset(ctx, node.assetId);
      if (existing) {
        activeIncidentId = existing.incidentId;
        event(ctx, existing.incidentId, 'readings_out_of_range', `${node.name}: readings outside limits again (${sensor.summarize(breaches)}); attached to this open incident`, { actorName: sp.name, assetId: node.assetId, metadata: [{ key: 'node', value: node.nodeId }] });
        addRealEvidence(ctx, existing.incidentId, node.assetId, sensor.buildEvidence(node.nodeId, node.sensorModel, breaches, history));
        touchIncident(ctx, existing.incidentId);
      } else {
        activeIncidentId = openEnvironmentalIncident(ctx, sp.name, node, breaches, history);
      }
    } else if (activeIncidentId !== undefined && calmStreak === sensor.CALM_STREAK_TO_CLEAR) {
      const text = `${sensor.CALM_STREAK_TO_CLEAR} consecutive readings back inside limits (latest ${latest.tempC.toFixed(1)} °C, ${latest.humidityPct.toFixed(0)}%)`;
      event(ctx, activeIncidentId, 'readings_normalized', `${node.name}: ${text}`, { actorName: sp.name, assetId: node.assetId, metadata: [{ key: 'node', value: node.nodeId }] });
      addRealEvidence(ctx, activeIncidentId, node.assetId, [
        { kind: 'environment', title: 'Readings returned within limits', detail: `Sensor ${node.nodeId}: ${text}.`, severity: 'info', indicators: [{ key: 'node', value: node.nodeId }, { key: 'temp_c', value: latest.tempC.toFixed(1) }, { key: 'humidity_pct', value: latest.humidityPct.toFixed(0) }] },
      ]);
    }

    ctx.db.sensorNode.nodeId.update({ ...node, status: 'online', lastReadingAt: ctx.timestamp, breachStreak, calmStreak, activeIncidentId });
    ctx.db.servicePrincipal.identity.update({ ...sp, lastSeenAt: ctx.timestamp });
  }
);

/** Gateway reports that a node stopped reporting (monitoring lost). Opens a REAL incident with measured evidence. */
export const report_sensor_fault = spacetimedb.reducer(
  { nodeId: t.string(), kind: t.string(), detail: t.string() },
  (ctx, { nodeId, kind, detail }) => {
    const sp = requireService(ctx, 'hardware_gateway');
    const node = ctx.db.sensorNode.nodeId.find(nodeId);
    if (!node) throw new SenderError(`Sensor node '${nodeId.slice(0, 48)}' is not registered`);
    v.oneOf(kind, ['silent'] as const, 'fault kind');
    const d = v.singleLine(detail, 'Detail', 3, 200);
    if (node.status === 'silent' && incidentIsOpen(ctx, node.silentIncidentId)) return; // already reported
    const asset = requireAsset(ctx, node.assetId);
    const open = openRealIncidentForAsset(ctx, node.assetId);
    if (open) {
      // An older incident for this asset is still open: record the silence on it instead of opening a new ticket.
      event(ctx, open.incidentId, 'sensor_silent', `${node.name} stopped reporting: ${d}`, { actorName: sp.name, assetId: node.assetId, metadata: [{ key: 'node', value: node.nodeId }] });
      touchIncident(ctx, open.incidentId);
      ctx.db.sensorNode.nodeId.update({ ...node, status: 'silent', silentIncidentId: open.incidentId });
      return;
    }
    const last = node.lastReadingAt ? new Date(Number(node.lastReadingAt.microsSinceUnixEpoch / 1000n)).toISOString() : 'never';
    const inc = ctx.db.incident.insert({
      incidentId: 0n,
      title: `Sentinel node ${node.name} stopped reporting`.slice(0, 120),
      description: `REAL EVENT: no readings were received from physical sensor node ${node.nodeId}. Monitoring of ${asset.name} is blind until it resumes. This can indicate a power, network or tampering problem.`,
      severity: 'medium',
      status: 'open',
      scenarioType: SILENT_SCENARIO,
      initialAssetId: asset.assetId,
      isSimulation: false,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolutionSummary: undefined,
    });
    event(ctx, inc.incidentId, 'incident_created', `Real monitoring-lost incident opened for sensor ${node.nodeId}: ${d}`, {
      actor: ctx.sender,
      actorName: sp.name,
      assetId: asset.assetId,
      metadata: [{ key: 'scenario', value: SILENT_SCENARIO }, { key: 'source', value: 'physical_sensor' }, { key: 'simulation', value: 'false' }, { key: 'node', value: node.nodeId }],
    });
    addRealEvidence(ctx, inc.incidentId, asset.assetId, [
      { kind: 'sensor_health', title: 'Sensor stopped reporting', detail: d, severity: 'medium', indicators: [{ key: 'node', value: node.nodeId }, { key: 'sensor', value: node.sensorModel }, { key: 'last_reading_at', value: last }, { key: 'reported_by', value: sp.name }] },
    ]);
    requestInvestigationFor(ctx, inc.incidentId, sp.name);
    ctx.db.sensorNode.nodeId.update({ ...node, status: 'silent', silentIncidentId: inc.incidentId });
    audit(ctx, sp.name, 'open_sensor_silent_incident', 'incident', String(inc.incidentId));
  }
);

// ═══════════════════ Response Decision Lab ═══════════════════
//
// Preview is pure and client-side (decisionLab.ts). Anything SHARED goes through
// these reducers, which re-run the same engine against authoritative state and
// reject proposals built on a stale preview. Nothing here executes containment
// or recovery: those stay behind apply_containment and the two-person
// request_recovery / decide_recovery workflow.

const MAX_PENDING_PROPOSALS = 8;

function labInput(ctx: Ctx, incidentId: bigint, targetAssetId: string): lab.LabInput {
  const inc = requireIncident(ctx, incidentId);
  return {
    incidentId: String(incidentId),
    incidentStatus: inc.status,
    assets: [...ctx.db.asset.iter()].map(a => ({ assetId: a.assetId, name: a.name, criticality: a.criticality as Criticality })),
    edges: graphEdges(ctx),
    effects: liveEffects(ctx).map(e => ({ incidentId: String(e.incidentId), assetId: e.assetId, kind: e.kind as EffectKind, level: e.level === 'offline' ? 'offline' : 'degraded', phase: e.phase as EffectPhase, intensity: e.intensity })),
    targetAssetId,
    pendingRecoveryAssetIds: [...ctx.db.recoveryAction.incidentId.filter(incidentId)].filter(r => r.status === 'pending').map(r => r.assetId),
  };
}

function evaluateOrReject(input: lab.LabInput, strategy: string): lab.StrategyResult {
  try {
    return lab.evaluateStrategy(input, strategy);
  } catch (err) {
    if (err instanceof lab.LabError) throw new SenderError(err.message);
    throw err;
  }
}

const STALE = 'Stale proposal: the incident changed since this preview was computed. Re-run the Decision Lab comparison and propose again.';

export const propose_response = spacetimedb.reducer(
  { incidentId: t.u64(), strategy: t.string(), targetAssetId: t.string(), rationale: t.string(), stateFingerprint: t.string() },
  (ctx, { incidentId, strategy, targetAssetId, rationale, stateFingerprint }) => {
    const me = requireRole(ctx, PERMS.proposeResponse, 'propose_response');
    requireOpenIncident(ctx, incidentId);
    const s = v.oneOf(strategy, lab.STRATEGY_IDS, 'strategy');
    const target = requireAsset(ctx, targetAssetId).assetId;
    const why = v.text(rationale, 'Rationale', 0, 500);
    const input = labInput(ctx, incidentId, target);
    if (lab.stateFingerprint(input) !== stateFingerprint) throw new SenderError(STALE);
    const result = evaluateOrReject(input, s);
    const existing = [...ctx.db.responseProposal.incidentId.filter(incidentId)].filter(p => p.status === 'pending');
    const dup = existing.find(p => p.strategy === s && p.targetAssetId === target);
    if (dup) throw new SenderError(`Proposal #${dup.proposalId} for this strategy is already pending`);
    if (existing.length >= MAX_PENDING_PROPOSALS) throw new SenderError(`Too many pending proposals (${MAX_PENDING_PROPOSALS}); decide or withdraw some first`);
    const nameOf = (id: string) => ctx.db.asset.assetId.find(id)?.name ?? id;
    const p = ctx.db.responseProposal.insert({
      proposalId: 0n,
      incidentId,
      strategy: s,
      targetAssetId: target,
      support: result.support,
      summary: lab.summarize(result, nameOf),
      rationale: why,
      stateFingerprint,
      status: 'pending',
      proposedBy: ctx.sender,
      proposerName: me.displayName,
      createdAt: ctx.timestamp,
      decidedBy: undefined,
      decidedAt: undefined,
      decisionNote: undefined,
    });
    event(ctx, incidentId, 'response_proposed', `${me.displayName} proposed "${result.name}" for ${nameOf(target)}${result.support === 'hypothetical' ? ' (hypothetical — includes modeled-only steps)' : ''}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      assetId: target,
      metadata: [
        { key: 'proposal_id', value: String(p.proposalId) },
        { key: 'strategy', value: s },
        { key: 'support', value: result.support },
      ],
    });
    touchIncident(ctx, incidentId);
    audit(ctx, me.displayName, `propose_response:${s}`, 'response_proposal', String(p.proposalId));
  }
);

/** Two-person: the proposer cannot adopt or reject their own plan. Adoption executes nothing. */
export const decide_response_proposal = spacetimedb.reducer(
  { proposalId: t.u64(), adopt: t.bool(), note: t.string() },
  (ctx, { proposalId, adopt, note }) => {
    const me = requireRole(ctx, PERMS.decideResponse, 'decide_response_proposal');
    const p = ctx.db.responseProposal.proposalId.find(proposalId);
    if (!p) throw new SenderError(`Proposal ${proposalId} not found`);
    if (p.status !== 'pending') throw new SenderError(`Proposal ${proposalId} is already ${p.status}`);
    if (p.proposedBy.isEqual(ctx.sender)) throw new SenderError('Two-person rule: the proposer cannot adopt or reject their own response plan');
    requireOpenIncident(ctx, p.incidentId);
    const n = v.text(note, 'Decision note', 0, 500);
    if (adopt) {
      const input = labInput(ctx, p.incidentId, p.targetAssetId);
      if (lab.stateFingerprint(input) !== p.stateFingerprint) throw new SenderError(STALE);
      evaluateOrReject(input, p.strategy);
    }
    ctx.db.responseProposal.proposalId.update({ ...p, status: adopt ? 'adopted' : 'rejected', decidedBy: ctx.sender, decidedAt: ctx.timestamp, decisionNote: n === '' ? undefined : n });
    const name = lab.STRATEGY_NAME[p.strategy as lab.StrategyId] ?? p.strategy;
    if (adopt) {
      const d = ctx.db.incidentDecision.insert({
        decisionId: 0n,
        incidentId: p.incidentId,
        summary: `Adopted response plan: ${name}`.slice(0, 160),
        rationale: `Proposal #${proposalId} by ${p.proposerName}, adopted by ${me.displayName}. ${p.summary}${n ? ` Note: ${n}` : ''}`.slice(0, 1000),
        actor: ctx.sender,
        actorName: me.displayName,
        actorRole: me.role,
        createdAt: ctx.timestamp,
      });
      void d;
    }
    event(ctx, p.incidentId, adopt ? 'response_adopted' : 'response_rejected', `${me.displayName} ${adopt ? 'adopted' : 'rejected'} response plan #${proposalId} (${name})${adopt ? ' — no action executed; steps still require their own controls and approvals' : ''}`, {
      actor: ctx.sender,
      actorName: me.displayName,
      assetId: p.targetAssetId,
      metadata: [{ key: 'proposal_id', value: String(proposalId) }],
    });
    touchIncident(ctx, p.incidentId);
    audit(ctx, me.displayName, adopt ? 'adopt_response' : 'reject_response', 'response_proposal', String(proposalId));
  }
);

export const withdraw_response_proposal = spacetimedb.reducer({ proposalId: t.u64() }, (ctx, { proposalId }) => {
  const me = requireResponder(ctx);
  const p = ctx.db.responseProposal.proposalId.find(proposalId);
  if (!p) throw new SenderError(`Proposal ${proposalId} not found`);
  if (!p.proposedBy.isEqual(ctx.sender)) throw new SenderError('Only the proposer can withdraw a proposal');
  if (p.status !== 'pending') throw new SenderError(`Proposal ${proposalId} is already ${p.status}`);
  ctx.db.responseProposal.proposalId.update({ ...p, status: 'withdrawn', decidedBy: ctx.sender, decidedAt: ctx.timestamp });
  event(ctx, p.incidentId, 'response_withdrawn', `${me.displayName} withdrew response plan #${proposalId}`, { actor: ctx.sender, actorName: me.displayName });
  audit(ctx, me.displayName, 'withdraw_response', 'response_proposal', String(proposalId));
});

// ─────────────── Nemotron explanation of a comparison ───────────────

export const request_decision_explanation = spacetimedb.reducer({ incidentId: t.u64(), targetAssetId: t.string() }, (ctx, { incidentId, targetAssetId }) => {
  const me = requireRole(ctx, PERMS.requestRecovery, 'request_decision_explanation');
  requireOpenIncident(ctx, incidentId);
  const target = requireAsset(ctx, targetAssetId).assetId;
  const input = labInput(ctx, incidentId, target);
  try {
    lab.evaluateAll(input);
  } catch (err) {
    if (err instanceof lab.LabError) throw new SenderError(err.message);
    throw err;
  }
  const active = [...ctx.db.decisionExplanation.incidentId.filter(incidentId)].find(x => x.status === 'requested' || x.status === 'running');
  if (active) throw new SenderError(`Explanation #${active.explanationId} is already ${active.status}`);
  const x = ctx.db.decisionExplanation.insert({
    explanationId: 0n,
    incidentId,
    targetAssetId: target,
    stateFingerprint: lab.stateFingerprint(input),
    status: 'requested',
    requestedBy: ctx.sender,
    requestedAt: ctx.timestamp,
    agent: undefined,
    model: '',
    text: undefined,
    citedEvidence: [],
    error: undefined,
    completedAt: undefined,
  });
  audit(ctx, me.displayName, 'request_decision_explanation', 'decision_explanation', String(x.explanationId));
});

export const cancel_decision_explanation = spacetimedb.reducer({ explanationId: t.u64() }, (ctx, { explanationId }) => {
  const me = requireRole(ctx, PERMS.requestRecovery, 'cancel_decision_explanation');
  const x = ctx.db.decisionExplanation.explanationId.find(explanationId);
  if (!x) throw new SenderError(`Explanation ${explanationId} not found`);
  if (x.status !== 'requested' && x.status !== 'running') throw new SenderError(`Explanation is already ${x.status}`);
  ctx.db.decisionExplanation.explanationId.update({ ...x, status: 'failed', error: `Cancelled by ${me.displayName}`, completedAt: ctx.timestamp });
  audit(ctx, me.displayName, 'cancel_decision_explanation', 'decision_explanation', String(explanationId));
});

export const agent_claim_explanation = spacetimedb.reducer({ explanationId: t.u64(), model: t.string() }, (ctx, { explanationId, model }) => {
  const sp = requireService(ctx, 'ai_agent');
  const x = ctx.db.decisionExplanation.explanationId.find(explanationId);
  if (!x) throw new SenderError(`Explanation ${explanationId} not found`);
  if (x.status !== 'requested') throw new SenderError(`Explanation ${explanationId} is ${x.status}`);
  ctx.db.decisionExplanation.explanationId.update({ ...x, status: 'running', agent: ctx.sender, model: v.singleLine(model, 'Model', 3, 120) });
  audit(ctx, sp.name, 'agent_claim_explanation', 'decision_explanation', String(explanationId));
});

/** The server rejects citations of evidence that does not belong to this incident (hallucinated evidence). */
export const agent_complete_explanation = spacetimedb.reducer(
  { explanationId: t.u64(), text: t.string(), citedEvidence: t.array(t.u64()), failed: t.bool() },
  (ctx, { explanationId, text, citedEvidence, failed }) => {
    const sp = requireService(ctx, 'ai_agent');
    const x = ctx.db.decisionExplanation.explanationId.find(explanationId);
    if (!x) throw new SenderError(`Explanation ${explanationId} not found`);
    if (x.status !== 'running') throw new SenderError(`Explanation ${explanationId} is ${x.status}`);
    if (!x.agent || !x.agent.isEqual(ctx.sender)) throw new SenderError('Explanation is claimed by a different agent');
    const body = v.text(text, failed ? 'Error' : 'Explanation', 1, 4000);
    if (!failed) {
      if (citedEvidence.length > 24) throw new SenderError('Too many citations');
      const own = new Set([...ctx.db.incidentEvidence.incidentId.filter(x.incidentId)].map(e => e.evidenceId));
      const bad = citedEvidence.filter(id => !own.has(id));
      if (bad.length > 0) throw new SenderError(`Cited evidence not found for incident ${x.incidentId}: ${bad.join(', ')}`);
    }
    ctx.db.decisionExplanation.explanationId.update({
      ...x,
      status: failed ? 'failed' : 'completed',
      text: failed ? undefined : body,
      citedEvidence: failed ? [] : [...new Set(citedEvidence)],
      error: failed ? body : undefined,
      completedAt: ctx.timestamp,
    });
    audit(ctx, sp.name, failed ? 'agent_fail_explanation' : 'agent_complete_explanation', 'decision_explanation', String(explanationId));
  }
);
