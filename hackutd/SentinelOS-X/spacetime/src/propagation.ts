// Deterministic dependency-impact analysis for the SentinelOS X digital twin.
//
// Edge semantics: a dependency edge A -> B means
//   "Component A requires Component B to provide its intended service."
// A is the *dependent*, B is the *required* asset. Failures therefore flow
// against the edge direction: if B fails, A (and A's dependents) may suffer.
//
// Dependency policy (Phase 1):
//   required    : B offline  -> A offline
//                 B degraded -> A degraded
//   noncritical : B offline or degraded -> A degraded
//   optional    : no automatic effect
//
// The result is a pure function of (assets, edges, direct failures). It never
// consults an LLM, a clock or randomness, so it is fully reproducible.
//
// Cycle safety: an asset's impact level only ever increases
// (healthy -> degraded -> offline), so each asset can be re-queued at most
// twice. The worklist therefore terminates on any graph, cyclic or not.

export const DEPENDENCY_TYPES = ['required', 'noncritical', 'optional'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export type ImpactLevel = 'healthy' | 'degraded' | 'offline';

export interface GraphEdge {
  dependentAssetId: string;
  requiredAssetId: string;
  dependencyType: DependencyType;
}

export interface AssetImpact {
  assetId: string;
  level: ImpactLevel;
  /** 'direct' for the failed asset itself, 'cascade' for dependency-induced impact. */
  impactType: 'direct' | 'cascade' | 'none';
  /** Hops from the nearest direct failure that produced this level (0 = direct). */
  depth: number;
  /** The required asset whose state produced this impact (cascade only). */
  causedBy: string | null;
  /** Edge type through which the impact arrived (cascade only). */
  via: DependencyType | null;
}

const RANK: Record<ImpactLevel, number> = { healthy: 0, degraded: 1, offline: 2 };

export function worse(a: ImpactLevel, b: ImpactLevel): ImpactLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Impact a dependent receives across one edge, given the required asset's level. */
export function edgeImpact(type: DependencyType, required: ImpactLevel): ImpactLevel {
  if (required === 'healthy') return 'healthy';
  switch (type) {
    case 'required':
      return required;
    case 'noncritical':
      return 'degraded';
    case 'optional':
      return 'healthy';
  }
}

/**
 * Compute the impact on every asset given a set of directly failed assets.
 * `directFailures` maps assetId -> the level forced on it ('offline' or 'degraded').
 * Assets referenced by edges but missing from `assetIds` are ignored.
 */
export function computeImpacts(
  assetIds: readonly string[],
  edges: readonly GraphEdge[],
  directFailures: ReadonlyMap<string, Exclude<ImpactLevel, 'healthy'>>
): Map<string, AssetImpact> {
  const known = new Set(assetIds);
  const result = new Map<string, AssetImpact>();
  // Sorted ids keep iteration order (and thus causedBy tie-breaks) deterministic.
  for (const id of [...known].sort()) {
    const forced = directFailures.get(id);
    result.set(id, {
      assetId: id,
      level: forced ?? 'healthy',
      impactType: forced ? 'direct' : 'none',
      depth: 0,
      causedBy: null,
      via: null,
    });
  }

  // requiredAssetId -> edges whose required side is that asset.
  const dependentsOf = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!known.has(e.dependentAssetId) || !known.has(e.requiredAssetId)) continue;
    if (e.dependentAssetId === e.requiredAssetId) continue; // self-loops carry no meaning
    const list = dependentsOf.get(e.requiredAssetId) ?? [];
    list.push(e);
    dependentsOf.set(e.requiredAssetId, list);
  }
  for (const list of dependentsOf.values()) {
    list.sort((a, b) => a.dependentAssetId.localeCompare(b.dependentAssetId));
  }

  const queue: string[] = [...directFailures.keys()].filter(id => known.has(id)).sort();
  let guard = 0;
  const maxSteps = (known.size + 1) * (edges.length + 1) * 3;

  while (queue.length > 0) {
    if (++guard > maxSteps) throw new Error('propagation did not converge');
    const requiredId = queue.shift()!;
    const required = result.get(requiredId)!;
    for (const edge of dependentsOf.get(requiredId) ?? []) {
      const incoming = edgeImpact(edge.dependencyType, required.level);
      if (incoming === 'healthy') continue;
      const dep = result.get(edge.dependentAssetId)!;
      if (RANK[incoming] <= RANK[dep.level]) continue; // no escalation -> no requeue
      result.set(dep.assetId, {
        assetId: dep.assetId,
        level: incoming,
        // A directly failed asset keeps its 'direct' classification even if a
        // dependency would also have taken it down.
        impactType: dep.impactType === 'direct' ? 'direct' : 'cascade',
        depth: dep.impactType === 'direct' ? 0 : required.depth + 1,
        causedBy: dep.impactType === 'direct' ? null : requiredId,
        via: dep.impactType === 'direct' ? null : edge.dependencyType,
      });
      queue.push(dep.assetId);
    }
  }
  return result;
}

export const CRITICALITIES = ['low', 'medium', 'high', 'mission_critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Deterministic incident severity from the current impact set.
 *  - any mission_critical asset offline            -> critical
 *  - any high asset offline, or mission_critical degraded -> high
 *  - any other offline asset, or high degraded     -> medium
 *  - only lower-criticality degradation            -> low
 */
export function severityFromImpacts(
  impacts: Iterable<AssetImpact>,
  criticalityOf: (assetId: string) => Criticality
): Severity {
  let sev: Severity = 'low';
  const bump = (s: Severity) => {
    if (SEVERITIES.indexOf(s) > SEVERITIES.indexOf(sev)) sev = s;
  };
  for (const i of impacts) {
    if (i.level === 'healthy') continue;
    const c = criticalityOf(i.assetId);
    if (i.level === 'offline') {
      bump(c === 'mission_critical' ? 'critical' : c === 'high' ? 'high' : 'medium');
    } else {
      bump(c === 'mission_critical' ? 'high' : c === 'high' ? 'medium' : 'low');
    }
  }
  return sev;
}

/** Map an impact to the (operationalStatus, healthStatus) pair stored on assets. */
export function statusesFor(impact: AssetImpact): {
  operationalStatus: 'online' | 'degraded' | 'offline';
  healthStatus: 'healthy' | 'degraded' | 'critical' | 'offline';
} {
  if (impact.level === 'healthy') return { operationalStatus: 'online', healthStatus: 'healthy' };
  if (impact.level === 'degraded') return { operationalStatus: 'degraded', healthStatus: 'degraded' };
  // Directly compromised assets are 'critical'; assets taken down by a
  // dependency are 'offline'. Both are operationally offline.
  return {
    operationalStatus: 'offline',
    healthStatus: impact.impactType === 'direct' ? 'critical' : 'offline',
  };
}

// ═══════════════════════ Phase 2: blast-radius engine ═══════════════════════
//
// Incidents attach EFFECTS to root assets. Each effect kind propagates
// differently (Phase 2 rules):
//
//   kind        root health   operational propagation      security exposure
//   outage      critical      yes (edge policy above)      no
//   fault       crit/degr     yes                          no   (manual fault injection, legacy)
//   overload    degraded→crit yes, as degradation          no   (latency, not a breach)
//   compromise  critical      no (root degraded locally)   yes  (dependents "potentially exposed")
//   integrity   critical      yes, as degradation          yes  (lateral-spread risk)
//
// Phases: active → contained → recovering → cleared.
//   contained : compromise stops exposing; integrity is isolated (root offline,
//               exposure stops); overload is rate-limited (root back to degraded).
//   recovering: root shows "recovering", dependents degraded until cleared.
//   cleared   : no effect.
//
// Exposure travels from a root to its dependents across required and
// noncritical edges (they trust/consume the root); optional edges do not carry it.

export const EFFECT_KINDS = ['outage', 'fault', 'overload', 'compromise', 'integrity'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
export const EFFECT_PHASES = ['active', 'contained', 'recovering', 'cleared'] as const;
export type EffectPhase = (typeof EFFECT_PHASES)[number];

export type HealthState = 'healthy' | 'degraded' | 'critical' | 'offline' | 'recovering';
export type ImpactClass = 'confirmed' | 'unavailable' | 'degraded' | 'exposed' | 'none';

export interface EffectInput {
  assetId: string;
  kind: EffectKind;
  level: Exclude<ImpactLevel, 'healthy'>;
  phase: EffectPhase;
  /** Overload escalation 0..1 (≥ 1 ⇒ saturated, root critical). */
  intensity?: number;
}

export interface ResolvedEffect {
  level: Exclude<ImpactLevel, 'healthy'>;
  propagate: boolean;
  exposes: boolean;
  rootHealth: 'critical' | 'degraded' | 'recovering';
  recovering: boolean;
}

/** Containment action available for an effect kind (undefined = recover directly). */
export const CONTAINMENT: Partial<Record<EffectKind, { action: string; label: string }>> = {
  compromise: { action: 'revoke_sessions', label: 'Revoke sessions & rotate signing keys' },
  overload: { action: 'enable_rate_limiting', label: 'Enable rate limiting & WAF challenge' },
  integrity: { action: 'isolate_service', label: 'Isolate service from the network' },
};

export function resolveEffect(e: EffectInput): ResolvedEffect | null {
  if (e.phase === 'cleared') return null;
  if (e.phase === 'recovering') return { level: 'degraded', propagate: true, exposes: false, rootHealth: 'recovering', recovering: true };
  const contained = e.phase === 'contained';
  switch (e.kind) {
    case 'outage':
      return { level: e.level, propagate: true, exposes: false, rootHealth: 'critical', recovering: false };
    case 'fault':
      return { level: e.level, propagate: true, exposes: false, rootHealth: e.level === 'offline' ? 'critical' : 'degraded', recovering: false };
    case 'overload':
      return { level: 'degraded', propagate: true, exposes: false, rootHealth: !contained && (e.intensity ?? 0) >= 1 ? 'critical' : 'degraded', recovering: false };
    case 'compromise':
      return { level: 'degraded', propagate: false, exposes: !contained, rootHealth: 'critical', recovering: false };
    case 'integrity':
      return contained
        ? { level: 'offline', propagate: true, exposes: false, rootHealth: 'critical', recovering: false }
        : { level: 'degraded', propagate: true, exposes: true, rootHealth: 'critical', recovering: false };
  }
}

export interface AssetBlast {
  assetId: string;
  level: ImpactLevel;
  role: 'root' | 'dependent' | 'none';
  /** Hops from the nearest root (operational if impacted, else exposure). 0 for roots. */
  depth: number;
  causedBy: string | null;
  via: DependencyType | null;
  exposed: boolean;
  exposureDepth: number | null;
  exposureFrom: string | null;
  health: HealthState;
  operationalStatus: 'online' | 'degraded' | 'offline';
  impactClass: ImpactClass;
}

const HEALTH_RANK: Record<'critical' | 'degraded' | 'recovering', number> = { recovering: 0, degraded: 1, critical: 2 };

/**
 * Deterministic blast radius for a set of effects. Safe on empty graphs,
 * cycles, duplicate edges, self-loops, disconnected assets and effects that
 * reference unknown assets.
 */
export function computeBlastRadius(
  assetIds: readonly string[],
  edges: readonly GraphEdge[],
  effects: readonly EffectInput[]
): Map<string, AssetBlast> {
  const known = new Set(assetIds);
  const ids = [...known].sort();

  // Roots: worst propagating level, worst local level, worst root health.
  const propagating = new Map<string, Exclude<ImpactLevel, 'healthy'>>();
  const propagatingActive = new Map<string, Exclude<ImpactLevel, 'healthy'>>();
  const local = new Map<string, Exclude<ImpactLevel, 'healthy'>>();
  const rootHealth = new Map<string, 'critical' | 'degraded' | 'recovering'>();
  const exposureRoots = new Set<string>();
  const put = (m: Map<string, Exclude<ImpactLevel, 'healthy'>>, id: string, l: Exclude<ImpactLevel, 'healthy'>) => m.set(id, m.has(id) ? (worse(m.get(id)!, l) as Exclude<ImpactLevel, 'healthy'>) : l);

  for (const e of effects) {
    if (!known.has(e.assetId)) continue;
    const r = resolveEffect(e);
    if (!r) continue;
    put(local, e.assetId, r.level);
    if (r.propagate) {
      put(propagating, e.assetId, r.level);
      if (!r.recovering) put(propagatingActive, e.assetId, r.level);
    }
    if (r.exposes) exposureRoots.add(e.assetId);
    const prev = rootHealth.get(e.assetId);
    if (!prev || HEALTH_RANK[r.rootHealth] > HEALTH_RANK[prev]) rootHealth.set(e.assetId, r.rootHealth);
  }

  const full = computeImpacts(ids, edges, propagating);
  const activeOnly = computeImpacts(ids, edges, propagatingActive);

  // Exposure BFS over dependents (deduplicated edges, sorted for determinism).
  const exposureDependents = new Map<string, string[]>();
  for (const e of edges) {
    if (e.dependencyType === 'optional' || e.dependentAssetId === e.requiredAssetId) continue;
    if (!known.has(e.dependentAssetId) || !known.has(e.requiredAssetId)) continue;
    const list = exposureDependents.get(e.requiredAssetId) ?? [];
    if (!list.includes(e.dependentAssetId)) list.push(e.dependentAssetId);
    exposureDependents.set(e.requiredAssetId, list);
  }
  for (const list of exposureDependents.values()) list.sort();
  const exposure = new Map<string, { depth: number; from: string }>();
  const queue: { id: string; depth: number }[] = [...exposureRoots].sort().map(id => ({ id, depth: 0 }));
  const seen = new Set(exposureRoots);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const dep of exposureDependents.get(cur.id) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      exposure.set(dep, { depth: cur.depth + 1, from: cur.id });
      queue.push({ id: dep, depth: cur.depth + 1 });
    }
  }

  const out = new Map<string, AssetBlast>();
  for (const id of ids) {
    const op = full.get(id)!;
    const isRoot = rootHealth.has(id);
    const level: ImpactLevel = isRoot ? worse(op.level, local.get(id)!) : op.level;
    const exp = isRoot ? undefined : exposure.get(id);
    let health: HealthState;
    const rh = rootHealth.get(id);
    if (rh === 'critical') health = 'critical';
    // A root that is only degraded/recovering itself but taken down (or held
    // degraded) by ANOTHER live effect through its dependencies reports the
    // worse state — "recovering" must never mask a dependency outage.
    else if (rh === 'degraded') health = level === 'offline' ? 'offline' : 'degraded';
    else if (rh === 'recovering') health = level === 'offline' ? 'offline' : activeOnly.get(id)!.level !== 'healthy' ? 'degraded' : 'recovering';
    else if (level === 'offline') health = 'offline';
    else if (level === 'degraded') health = activeOnly.get(id)!.level === 'healthy' ? 'recovering' : 'degraded';
    else health = 'healthy';
    const role: AssetBlast['role'] = isRoot ? 'root' : level !== 'healthy' || exp ? 'dependent' : 'none';
    const impactClass: ImpactClass = isRoot ? 'confirmed' : level === 'offline' ? 'unavailable' : level === 'degraded' ? 'degraded' : exp ? 'exposed' : 'none';
    const operationalCause = !isRoot && level !== 'healthy';
    out.set(id, {
      assetId: id,
      level,
      role,
      depth: isRoot ? 0 : operationalCause ? op.depth : (exp?.depth ?? 0),
      causedBy: operationalCause ? op.causedBy : null,
      via: operationalCause ? op.via : null,
      exposed: !!exp,
      exposureDepth: exp?.depth ?? null,
      exposureFrom: exp?.from ?? null,
      health,
      operationalStatus: level === 'healthy' ? 'online' : level,
      impactClass,
    });
  }
  return out;
}

/**
 * Incident severity from a blast radius. Operational rules match
 * severityFromImpacts; security rules add:
 *  - confirmed critical root: severity by criticality (mission_critical → critical)
 *  - potentially exposed mission_critical asset → at least high, high → medium
 */
export function severityFromBlast(blast: Iterable<AssetBlast>, criticalityOf: (assetId: string) => Criticality): Severity {
  let sev: Severity = 'low';
  const bump = (s: Severity) => {
    if (SEVERITIES.indexOf(s) > SEVERITIES.indexOf(sev)) sev = s;
  };
  const byCrit: Record<Criticality, Severity> = { mission_critical: 'critical', high: 'high', medium: 'medium', low: 'low' };
  for (const b of blast) {
    if (b.role === 'none') continue;
    const c = criticalityOf(b.assetId);
    if (b.role === 'root' && b.health === 'critical') bump(byCrit[c]);
    if (b.level === 'offline') bump(c === 'mission_critical' ? 'critical' : c === 'high' ? 'high' : 'medium');
    else if (b.level === 'degraded') bump(c === 'mission_critical' ? 'high' : c === 'high' ? 'medium' : 'low');
    if (b.exposed) bump(c === 'mission_critical' ? 'high' : c === 'high' ? 'medium' : 'low');
  }
  return sev;
}
