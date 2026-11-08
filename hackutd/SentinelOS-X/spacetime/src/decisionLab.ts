// Response Decision Lab — deterministic, NON-DESTRUCTIVE strategy evaluation.
//
// Given the authoritative graph and one incident's live effects, this module
// answers "what would happen if we isolate / restore / fail over / stage the
// response for this root service?" by transforming a COPY of the effect list
// and re-running the same blast-radius engine the module uses for real state.
//
// It never mutates its input, never reads a clock or randomness, and never
// produces numbers the engine cannot compute (no probabilities, times, costs or
// confidence scores). It is shared by:
//   - the SpacetimeDB module (propose_response revalidates server-side),
//   - the browser (labelled preview only),
//   - the Nemotron agent (explanations receive these structured results).
import {
  computeBlastRadius,
  severityFromBlast,
  CONTAINMENT,
  type AssetBlast,
  type Criticality,
  type EffectInput,
  type EffectKind,
  type EffectPhase,
  type GraphEdge,
  type Severity,
} from './propagation';

export const STRATEGY_IDS = ['isolate', 'restore', 'failover', 'staged'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const STRATEGY_NAME: Record<StrategyId, string> = {
  isolate: 'Isolate the affected service',
  restore: 'Restore the service (approved recovery)',
  failover: 'Fail over to a standby',
  staged: 'Staged containment, then recovery',
};

export interface LabAsset {
  assetId: string;
  name: string;
  criticality: Criticality;
}

export interface LabEffect {
  incidentId: string;
  assetId: string;
  kind: EffectKind;
  level: 'offline' | 'degraded';
  phase: EffectPhase;
  intensity: number;
}

export interface LabInput {
  incidentId: string;
  incidentStatus: string;
  assets: readonly LabAsset[];
  edges: readonly GraphEdge[];
  /** All live (non-cleared) effects across all incidents. */
  effects: readonly LabEffect[];
  targetAssetId: string;
  /** Assets of this incident that already have a pending recovery request. */
  pendingRecoveryAssetIds: readonly string[];
}

export type AssetState = 'offline' | 'degraded' | 'recovering' | 'exposed' | 'healthy';
export const STATE_RANK: Record<AssetState, number> = { healthy: 0, recovering: 1, exposed: 2, degraded: 3, offline: 4 };

export interface AssetSnapshot {
  state: AssetState;
  role: 'root' | 'dependent' | 'none';
  /** Hops from the root (0 for roots). */
  depth: number;
  causedBy: string | null;
}

export interface ImpactSnapshot {
  assets: Record<string, AssetSnapshot>;
  counts: Record<AssetState, number>;
  /** Engine severity; 'none' when nothing is impacted. */
  severity: Severity | 'none';
}

export type StepOperation = 'apply_containment' | 'request_recovery' | 'decide_recovery' | 'modeled_isolation' | 'modeled_failover' | 'no_op';

export interface LabStep {
  label: string;
  operation: StepOperation;
  /** true: an existing reducer can perform it. false: modeled only — no backend operation exists. */
  executable: boolean;
  approval: 'none' | 'two_person';
}

export interface LabStage {
  label: string;
  impact: ImpactSnapshot;
}

export interface Precondition {
  text: string;
  met: boolean;
}

export interface StrategyResult {
  strategy: StrategyId;
  name: string;
  /** 'executable' = every step maps to an existing reducer; 'hypothetical' = at least one modeled-only step. */
  support: 'executable' | 'hypothetical';
  steps: LabStep[];
  stages: LabStage[];
  before: ImpactSnapshot;
  after: ImpactSnapshot;
  /** Impacted before, healthy after. */
  restored: string[];
  /** Strictly worse after than before. */
  disrupted: string[];
  /** Less impacted after, but not healthy. */
  improved: string[];
  /** Still impacted after (any non-healthy state). */
  stillAffected: string[];
  /** Fully operational after (healthy). */
  operational: string[];
  preconditions: Precondition[];
  approvals: string[];
  residualRisks: string[];
  assumptions: string[];
  unsupported: string[];
  warnings: string[];
}

export interface LabReport {
  incidentId: string;
  targetAssetId: string;
  fingerprint: string;
  results: StrategyResult[];
}

export class LabError extends Error {}

// ─────────────────────────── helpers ───────────────────────────

const LIVE = (p: EffectPhase) => p === 'active' || p === 'contained';

function hash(s: string): string {
  // djb2 (32-bit), hex — deterministic and dependency-free.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fingerprint of everything a preview depends on. A proposal made from a preview
 * is rejected if the fingerprint no longer matches the authoritative state.
 * Overload intensity is excluded on purpose: it ticks every few seconds and does
 * not change which services are affected.
 */
export function stateFingerprint(input: Pick<LabInput, 'incidentId' | 'incidentStatus' | 'effects' | 'edges' | 'assets'>): string {
  const effects = input.effects
    .filter(e => e.incidentId === input.incidentId && e.phase !== 'cleared')
    .map(e => `${e.assetId}:${e.kind}:${e.level}:${e.phase}`)
    .sort()
    .join('|');
  const edges = input.edges
    .map(e => `${e.dependentAssetId}>${e.requiredAssetId}:${e.dependencyType}`)
    .sort()
    .join('|');
  const assets = input.assets
    .map(a => a.assetId)
    .sort()
    .join('|');
  return `${input.incidentStatus}-${hash(effects)}-${hash(edges + '#' + assets)}`;
}

function stateOf(b: AssetBlast): AssetState {
  if (b.level === 'offline') return 'offline';
  if (b.health === 'recovering') return 'recovering';
  if (b.level === 'degraded') return 'degraded';
  if (b.exposed) return 'exposed';
  return 'healthy';
}

function snapshot(input: LabInput, effects: readonly EffectInput[]): ImpactSnapshot {
  const ids = input.assets.map(a => a.assetId);
  const crit = new Map(input.assets.map(a => [a.assetId, a.criticality]));
  const blast = computeBlastRadius(ids, input.edges, effects);
  const assets: Record<string, AssetSnapshot> = {};
  const counts: Record<AssetState, number> = { offline: 0, degraded: 0, recovering: 0, exposed: 0, healthy: 0 };
  for (const id of [...blast.keys()].sort()) {
    const b = blast.get(id)!;
    const state = stateOf(b);
    counts[state]++;
    assets[id] = { state, role: b.role, depth: b.depth, causedBy: b.causedBy ?? b.exposureFrom ?? null };
  }
  const impacted = [...blast.values()].filter(b => b.role !== 'none');
  const severity = impacted.length === 0 ? 'none' : severityFromBlast(impacted, id => crit.get(id) ?? 'low');
  return { assets, counts, severity };
}

const toInput = (e: LabEffect): EffectInput => ({ assetId: e.assetId, kind: e.kind, level: e.level, phase: e.phase, intensity: e.intensity });

type Transform = (e: LabEffect) => LabEffect | null; // null = effect removed (cleared)

function apply(effects: readonly LabEffect[], targetAssetId: string, incidentId: string, t: Transform): LabEffect[] {
  const out: LabEffect[] = [];
  for (const e of effects) {
    if (e.incidentId === incidentId && e.assetId === targetAssetId && LIVE(e.phase)) {
      const n = t({ ...e });
      if (n) out.push(n);
    } else out.push({ ...e });
  }
  return out;
}

function compare(before: ImpactSnapshot, after: ImpactSnapshot) {
  const restored: string[] = [];
  const disrupted: string[] = [];
  const improved: string[] = [];
  const stillAffected: string[] = [];
  const operational: string[] = [];
  for (const id of Object.keys(after.assets).sort()) {
    const b = before.assets[id]?.state ?? 'healthy';
    const a = after.assets[id]!.state;
    if (a === 'healthy') operational.push(id);
    else stillAffected.push(id);
    if (b !== 'healthy' && a === 'healthy') restored.push(id);
    else if (STATE_RANK[a] > STATE_RANK[b]) disrupted.push(id);
    else if (STATE_RANK[a] < STATE_RANK[b]) improved.push(id);
  }
  return { restored, disrupted, improved, stillAffected, operational };
}

const GRAPH_ASSUMPTIONS = [
  'Impact follows the modeled dependency graph: "required" edges pass on offline/degraded, "noncritical" edges pass on degradation only, "optional" edges pass nothing.',
  'The 16-service infrastructure is a modeled digital twin; predictions are about the model, not measured production systems.',
  'Only this incident\'s effects are modeled; other open incidents are reported as warnings, not combined.',
];

// ─────────────────────────── evaluation ───────────────────────────

/** Root-cause assets of this incident that still have a live (active/contained) effect. */
export function rootTargets(input: Pick<LabInput, 'incidentId' | 'effects'>): string[] {
  return [...new Set(input.effects.filter(e => e.incidentId === input.incidentId && LIVE(e.phase)).map(e => e.assetId))].sort();
}

function validate(input: LabInput) {
  if (input.incidentStatus === 'resolved') throw new LabError(`Incident ${input.incidentId} is resolved; there is nothing left to respond to`);
  if (!input.assets.some(a => a.assetId === input.targetAssetId)) throw new LabError(`Service '${input.targetAssetId}' does not exist in the digital twin`);
  if (!rootTargets(input).includes(input.targetAssetId)) {
    throw new LabError(`Service '${input.targetAssetId}' is not a live root cause of incident ${input.incidentId}; choose one of: ${rootTargets(input).join(', ') || '(none — the incident has no live root effect)'}`);
  }
}

export function evaluateStrategy(input: LabInput, strategy: string): StrategyResult {
  if (!(STRATEGY_IDS as readonly string[]).includes(strategy)) throw new LabError(`Unknown strategy '${strategy}'. Expected one of: ${STRATEGY_IDS.join(', ')}`);
  validate(input);
  const s = strategy as StrategyId;
  const mine = input.effects.filter(e => e.incidentId === input.incidentId);
  const targetEffects = mine.filter(e => e.assetId === input.targetAssetId && LIVE(e.phase));
  const nameOf = (id: string) => input.assets.find(a => a.assetId === id)?.name ?? id;
  const target = nameOf(input.targetAssetId);
  const kinds = [...new Set(targetEffects.map(e => e.kind))].sort();
  const containable = targetEffects.filter(e => CONTAINMENT[e.kind]);
  const uncontained = containable.filter(e => e.phase === 'active');
  const securityKinds = kinds.filter(k => k === 'compromise' || k === 'integrity');
  const pending = input.pendingRecoveryAssetIds.includes(input.targetAssetId);

  const snap = (effs: readonly LabEffect[]) => snapshot(input, effs.filter(e => e.incidentId === input.incidentId).map(toInput));
  const before = snap(input.effects);

  const steps: LabStep[] = [];
  const stages: LabStage[] = [];
  const preconditions: Precondition[] = [{ text: 'Incident is still open', met: true }];
  const approvals: string[] = [];
  const residualRisks: string[] = [];
  const assumptions: string[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  let final: LabEffect[];

  const containmentStep = (): LabEffect[] => {
    for (const e of uncontained) {
      steps.push({ label: `${CONTAINMENT[e.kind]!.label} on ${target}`, operation: 'apply_containment', executable: true, approval: 'none' });
    }
    return apply(input.effects, input.targetAssetId, input.incidentId, e => (CONTAINMENT[e.kind] && e.phase === 'active' ? { ...e, phase: 'contained' } : e));
  };
  const recoverySteps = () => {
    steps.push({ label: `Request recovery of ${target}`, operation: 'request_recovery', executable: true, approval: 'none' });
    steps.push({ label: `A second responder approves the recovery`, operation: 'decide_recovery', executable: true, approval: 'two_person' });
    approvals.push('Recovery requires two different responders: one requests, another approves (two-person rule, enforced server-side).');
    preconditions.push({ text: `No recovery for ${target} is already pending`, met: !pending });
    assumptions.push('Approved recovery is a SIMULATED restoration of the twin: the root effect enters "recovering" and clears after the engine\'s fixed recovery period (2 ticks).');
  };

  switch (s) {
    case 'isolate': {
      if (targetEffects.length > 0 && containable.length === targetEffects.length && uncontained.length === 0) {
        steps.push({ label: `${target} is already contained`, operation: 'no_op', executable: true, approval: 'none' });
        warnings.push('Containment is already in place; isolating again changes nothing.');
        final = input.effects.map(e => ({ ...e }));
      } else {
        final = containmentStep();
        const nonContainable = targetEffects.filter(e => !CONTAINMENT[e.kind]);
        if (nonContainable.length > 0) {
          const k = [...new Set(nonContainable.map(e => e.kind))].join(', ');
          steps.push({ label: `Isolate ${target} from the network (modeled only)`, operation: 'modeled_isolation', executable: false, approval: 'none' });
          unsupported.push(`The backend has no isolation operation for '${k}' effects. Isolation is modeled as taking ${target} fully offline.`);
          final = apply(final, input.targetAssetId, input.incidentId, e => (CONTAINMENT[e.kind] ? e : { ...e, kind: 'fault', level: 'offline', phase: 'active' }));
        }
      }
      if (uncontained.length > 0) approvals.push('Containment needs no second approval: any registered responder may apply it (it is reversible only through recovery).');
      residualRisks.push(`${target} stays out of normal service until a recovery is approved.`);
      if (kinds.includes('integrity')) residualRisks.push('Isolation stops lateral spread but takes the service offline, so services that require it go offline too.');
      if (kinds.includes('compromise')) residualRisks.push('Revoking sessions stops exposure from spreading; the service itself is still compromised until recovered.');
      stages.push({ label: 'After isolation', impact: snap(final) });
      break;
    }
    case 'restore': {
      preconditions.push({ text: `${target} is contained (required before recovery for ${kinds.filter(k => CONTAINMENT[k as EffectKind]).join(', ') || 'this effect'})`, met: uncontained.length === 0 });
      if (uncontained.length > 0) warnings.push(`The server will reject a recovery request until ${target} is contained. Use the staged plan instead.`);
      recoverySteps();
      const recovering = apply(input.effects, input.targetAssetId, input.incidentId, e => ({ ...e, phase: 'recovering' }));
      stages.push({ label: 'While recovering', impact: snap(recovering) });
      final = apply(input.effects, input.targetAssetId, input.incidentId, () => null);
      stages.push({ label: 'After recovery completes', impact: snap(final) });
      if (securityKinds.length > 0) residualRisks.push('Restoration in the twin does not prove the attacker was removed; verify credentials/files before trusting the service again.');
      break;
    }
    case 'failover': {
      steps.push({ label: `Fail ${target} over to a standby (modeled only)`, operation: 'modeled_failover', executable: false, approval: 'none' });
      unsupported.push('The backend has no failover operation and the twin contains no standby services. This strategy is hypothetical and cannot be executed from SentinelOS X.');
      assumptions.push(`A healthy standby for ${target} exists outside the modeled twin and takes over instantly with no data loss — this is an ASSUMPTION, not something the twin can verify.`);
      final = apply(input.effects, input.targetAssetId, input.incidentId, e => (e.kind === 'compromise' || e.kind === 'integrity' ? e : null));
      if (securityKinds.length > 0) {
        residualRisks.push(`Failover does not remediate a ${securityKinds.join('/')} effect: the standby would trust the same identities/files, so the modeled exposure is unchanged.`);
      }
      residualRisks.push(`The failed primary still needs repair; the twin keeps no record of it after a modeled failover.`);
      stages.push({ label: 'After modeled failover', impact: snap(final) });
      break;
    }
    case 'staged': {
      let current: LabEffect[] = input.effects.map(e => ({ ...e }));
      if (uncontained.length > 0) {
        current = containmentStep();
        stages.push({ label: 'Stage 1 — contained', impact: snap(current) });
        approvals.push('Stage 1 (containment) can be applied by any registered responder.');
      } else if (containable.length > 0) {
        steps.push({ label: `${target} already contained — skip stage 1`, operation: 'no_op', executable: true, approval: 'none' });
      } else {
        steps.push({ label: `No containment action exists for ${kinds.join(', ')} — go straight to recovery`, operation: 'no_op', executable: true, approval: 'none' });
      }
      recoverySteps();
      const recovering = apply(current, input.targetAssetId, input.incidentId, e => ({ ...e, phase: 'recovering' }));
      stages.push({ label: 'Stage 2 — recovering', impact: snap(recovering) });
      final = apply(current, input.targetAssetId, input.incidentId, () => null);
      stages.push({ label: 'Stage 3 — recovered', impact: snap(final) });
      if (securityKinds.length > 0) residualRisks.push('Restoration in the twin does not prove the attacker was removed; verify before closing the incident.');
      break;
    }
  }

  const after = stages[stages.length - 1]!.impact;
  const cmp = compare(before, after);
  const otherRoots = rootTargets(input).filter(id => id !== input.targetAssetId);
  if (otherRoots.length > 0) residualRisks.push(`Other root causes remain in this incident: ${otherRoots.map(nameOf).join(', ')}.`);
  const otherIncidents = [...new Set(input.effects.filter(e => e.incidentId !== input.incidentId && e.phase !== 'cleared').map(e => e.incidentId))].sort();
  if (otherIncidents.length > 0) warnings.push(`Other open incidents also affect the twin (${otherIncidents.map(i => `#${i}`).join(', ')}); their effects are not included in this comparison.`);
  if (cmp.disrupted.length > 0) residualRisks.push(`This response makes ${cmp.disrupted.length} service(s) worse before things improve: ${cmp.disrupted.map(nameOf).join(', ')}.`);
  const sevRank = (x: Severity | 'none') => (x === 'none' ? -1 : ['low', 'medium', 'high', 'critical'].indexOf(x));
  if (sevRank(after.severity) > sevRank(before.severity)) warnings.push(`Modeled severity rises from ${before.severity} to ${after.severity}.`);

  return {
    strategy: s,
    name: STRATEGY_NAME[s],
    support: steps.some(x => !x.executable) ? 'hypothetical' : 'executable',
    steps,
    stages,
    before,
    after,
    ...cmp,
    preconditions,
    approvals,
    residualRisks,
    assumptions: [...assumptions, ...GRAPH_ASSUMPTIONS],
    unsupported,
    warnings,
  };
}

export function evaluateAll(input: LabInput): LabReport {
  validate(input);
  return {
    incidentId: input.incidentId,
    targetAssetId: input.targetAssetId,
    fingerprint: stateFingerprint(input),
    results: STRATEGY_IDS.map(s => evaluateStrategy(input, s)),
  };
}

/** One-line, server-computed summary stored with a proposal (never model-generated). */
export function summarize(r: StrategyResult, nameOf: (id: string) => string = id => id): string {
  const list = (ids: string[]) => (ids.length === 0 ? 'none' : ids.map(nameOf).join(', '));
  return `${r.name} [${r.support}] — restores: ${list(r.restored)}; disrupts: ${list(r.disrupted)}; still affected after: ${r.stillAffected.length}; modeled severity ${r.before.severity} → ${r.after.severity}`.slice(0, 500);
}

export interface LabRecommendation {
  strategy: StrategyId;
  rationale: string;
}

/**
 * Deterministic pick: the executable strategy with all preconditions met that
 * restores the most services, then makes the fewest worse, then leaves the
 * fewest affected (ties broken by the fixed strategy order). Hypothetical
 * strategies are never recommended. Returns null when nothing is executable.
 */
export function recommend(report: LabReport, nameOf: (id: string) => string = id => id): LabRecommendation | null {
  const order = (s: StrategyId) => STRATEGY_IDS.indexOf(s);
  const ranked = report.results
    .filter(r => r.support === 'executable')
    .map(r => ({ r, unmet: r.preconditions.filter(p => !p.met).length }))
    .sort((a, b) => a.unmet - b.unmet || b.r.restored.length - a.r.restored.length || a.r.disrupted.length - b.r.disrupted.length || a.r.stillAffected.length - b.r.stillAffected.length || order(a.r.strategy) - order(b.r.strategy));
  const best = ranked[0];
  if (!best) return null;
  const r = best.r;
  const hyp = report.results.filter(x => x.support === 'hypothetical').map(x => x.name);
  const why = [
    `It can be executed with existing controls${best.unmet ? ` once ${best.unmet} unmet precondition(s) are resolved` : ' and all preconditions are met'}.`,
    `Modeled result: restores ${r.restored.length} service(s), makes ${r.disrupted.length} worse${r.disrupted.length ? ` (${r.disrupted.map(nameOf).join(', ')})` : ''}, leaves ${r.stillAffected.length} affected; severity ${r.before.severity} → ${r.after.severity}.`,
  ];
  if (hyp.length) why.push(`Not considered: ${hyp.join(', ')} (hypothetical — cannot be executed here).`);
  return { strategy: r.strategy, rationale: why.join(' ') };
}
