// Pure derivations over subscribed rows. No state is stored here.
import type { Asset, Dependency, Incident, IncidentEvent } from '../types/domain';

export interface HealthCounts {
  total: number;
  healthy: number;
  degraded: number;
  critical: number;
  offline: number;
  recovering: number;
  /** Operationally healthy but potentially exposed through a trust dependency. */
  atRisk: number;
}

export function healthCounts(assets: readonly Asset[]): HealthCounts {
  const c: HealthCounts = { total: assets.length, healthy: 0, degraded: 0, critical: 0, offline: 0, recovering: 0, atRisk: 0 };
  for (const a of assets) {
    if (a.healthStatus === 'healthy' || a.healthStatus === 'degraded' || a.healthStatus === 'critical' || a.healthStatus === 'offline' || a.healthStatus === 'recovering') {
      c[a.healthStatus]++;
    }
    if (a.impactType === 'exposed') c.atRisk++;
  }
  return c;
}

export type RiskLevel = 'low' | 'elevated' | 'high' | 'severe';

/** Deterministic risk summary from subscribed incidents and asset health. */
export function riskSummary(incidents: readonly Incident[], assets: readonly Asset[]): { level: RiskLevel; reasons: string[] } {
  const active = incidents.filter(i => i.status !== 'resolved');
  const c = healthCounts(assets);
  const reasons: string[] = [];
  const bySev = (s: string) => active.filter(i => i.severity === s).length;
  if (active.length) reasons.push(`${active.length} active incident${active.length === 1 ? '' : 's'}${bySev('critical') ? ` (${bySev('critical')} critical)` : ''}`);
  if (c.critical + c.offline) reasons.push(`${c.critical} critical and ${c.offline} offline service${c.offline === 1 ? '' : 's'}`);
  if (c.degraded) reasons.push(`${c.degraded} degraded`);
  if (c.atRisk) reasons.push(`${c.atRisk} potentially exposed`);
  if (c.recovering) reasons.push(`${c.recovering} recovering`);
  const missionDown = assets.some(a => a.criticality === 'mission_critical' && (a.healthStatus === 'critical' || a.healthStatus === 'offline'));
  let level: RiskLevel = 'low';
  if (active.length || c.degraded || c.atRisk || c.recovering) level = 'elevated';
  if (bySev('high') || c.critical + c.offline > 0) level = 'high';
  if (bySev('critical') || missionDown) level = 'severe';
  if (reasons.length === 0) reasons.push('All monitored services healthy; no active incidents');
  return { level, reasons };
}

const CRIT_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3, mission_critical: 5 };
const HEALTH_SCORE: Record<string, number> = { healthy: 1, degraded: 0.5, recovering: 0.75, critical: 0, offline: 0 };

/** Criticality-weighted availability score, 0–100. */
export function healthScore(assets: readonly Asset[]): number {
  let total = 0;
  let got = 0;
  for (const a of assets) {
    const w = CRIT_WEIGHT[a.criticality] ?? 1;
    total += w;
    got += w * (HEALTH_SCORE[a.healthStatus] ?? 0);
  }
  return total === 0 ? 100 : Math.round((got / total) * 100);
}

/**
 * Deterministic left→right layered layout. Dependents sit left of what they
 * require: layer(a) = 0 if a requires nothing, else 1 + max(layer(required)).
 * Cycles are broken by a visit guard.
 */
export function layoutTwin(assets: readonly Asset[], deps: readonly Dependency[]): Map<string, { x: number; y: number; layer: number }> {
  const req = new Map<string, string[]>();
  for (const d of deps) req.set(d.dependentAssetId, [...(req.get(d.dependentAssetId) ?? []), d.requiredAssetId]);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const known = new Set(assets.map(a => a.assetId));
  const depth = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const kids = (req.get(id) ?? []).filter(k => known.has(k));
    const l = kids.length === 0 ? 0 : 1 + Math.max(...kids.map(depth));
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const a of assets) depth(a.assetId);
  const maxLayer = Math.max(0, ...layer.values());
  const cols = new Map<number, Asset[]>();
  for (const a of [...assets].sort((x, y) => x.environment.localeCompare(y.environment) || x.assetId.localeCompare(y.assetId))) {
    const col = maxLayer - (layer.get(a.assetId) ?? 0);
    cols.set(col, [...(cols.get(col) ?? []), a]);
  }
  // One barycenter sweep (left→right): order each column by the mean row of the
  // dependents that point at it, which reduces edge crossings deterministically.
  const rowOf = new Map<string, number>();
  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  for (const col of colKeys) {
    const list = cols.get(col)!;
    if (col > 0) {
      const score = (a: Asset) => {
        const rows = deps.filter(d => d.requiredAssetId === a.assetId && rowOf.has(d.dependentAssetId)).map(d => rowOf.get(d.dependentAssetId)!);
        return rows.length ? rows.reduce((x, y) => x + y, 0) / rows.length : Number.MAX_SAFE_INTEGER;
      };
      const scored = list.map((a, i) => ({ a, s: score(a), i }));
      scored.sort((x, y) => x.s - y.s || x.i - y.i);
      cols.set(col, scored.map(x => x.a));
    }
    cols.get(col)!.forEach((a, i) => rowOf.set(a.assetId, i));
  }
  const out = new Map<string, { x: number; y: number; layer: number }>();
  const COL_W = 300;
  const ROW_H = 130;
  const tallest = Math.max(1, ...[...cols.values()].map(c => c.length));
  for (const [col, list] of cols) {
    const offset = ((tallest - list.length) * ROW_H) / 2;
    list.forEach((a, i) => out.set(a.assetId, { x: col * COL_W, y: offset + i * ROW_H, layer: layer.get(a.assetId) ?? 0 }));
  }
  return out;
}

export function dependentsOf(assetId: string, deps: readonly Dependency[]) {
  return deps.filter(d => d.requiredAssetId === assetId);
}

export function requirementsOf(assetId: string, deps: readonly Dependency[]) {
  return deps.filter(d => d.dependentAssetId === assetId);
}

export type IncidentSort = 'newest' | 'oldest' | 'severity' | 'updated';

export interface IncidentFilter {
  query: string; // title, "INC-12" or "12"
  severity: string;
  status: string; // '' | 'active' | a status
  assetId: string;
  recentMinutes: number; // 0 = any time
  sort: IncidentSort;
}

export const EMPTY_INCIDENT_FILTER: IncidentFilter = { query: '', severity: '', status: '', assetId: '', recentMinutes: 0, sort: 'newest' };

const SEV: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const micros = (t: { microsSinceUnixEpoch: bigint }) => t.microsSinceUnixEpoch;
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

export function matchesIncidentQuery(i: Pick<Incident, 'incidentId' | 'title' | 'scenarioType'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const id = q.replace(/^inc-?/, '');
  if (/^\d+$/.test(id) && String(i.incidentId) === id) return true;
  return i.title.toLowerCase().includes(q) || i.scenarioType.replace(/_/g, ' ').includes(q);
}

export function filterIncidents(
  incidents: readonly Incident[],
  affectedAssets: Map<bigint, Set<string>>,
  f: IncidentFilter,
  nowMs = Date.now()
): Incident[] {
  const out = incidents
    .filter(i => matchesIncidentQuery(i, f.query))
    .filter(i => (f.severity ? i.severity === f.severity : true))
    .filter(i => (f.status === 'active' ? i.status !== 'resolved' : f.status ? i.status === f.status : true))
    .filter(i => (f.assetId ? (affectedAssets.get(i.incidentId)?.has(f.assetId) ?? false) : true))
    .filter(i => (f.recentMinutes > 0 ? nowMs - i.updatedAt.toDate().getTime() <= f.recentMinutes * 60_000 : true));
  const tie = (a: Incident, b: Incident) => cmpBig(b.incidentId, a.incidentId);
  switch (f.sort) {
    case 'oldest':
      return out.sort((a, b) => cmpBig(micros(a.createdAt), micros(b.createdAt)) || -tie(a, b));
    case 'severity':
      return out.sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0) || Number(a.status === 'resolved') - Number(b.status === 'resolved') || tie(a, b));
    case 'updated':
      return out.sort((a, b) => cmpBig(micros(b.updatedAt), micros(a.updatedAt)) || tie(a, b));
    default:
      return out.sort((a, b) => cmpBig(micros(b.createdAt), micros(a.createdAt)) || tie(a, b));
  }
}

/** Chronological order with a stable id tie-break (many events share one reducer timestamp). */
export function chronological(events: readonly IncidentEvent[]): IncidentEvent[] {
  return [...events].sort((a, b) => {
    const x = a.timestamp.microsSinceUnixEpoch;
    const y = b.timestamp.microsSinceUnixEpoch;
    if (x !== y) return x < y ? -1 : 1;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
}

// ── "Why is this service affected?" (attack-path explanation) ──

export interface ImpactExplanation {
  incidentId: bigint;
  /** root = a recorded effect on this service; cascade/exposed = propagated by the dependency model. */
  role: 'root' | 'cascade' | 'exposed';
  /** confirmed = an effect row exists on this asset; modeled = predicted from the dependency graph. */
  basis: 'confirmed' | 'modeled';
  /** Measured by a physical sensor, or synthetic scenario. */
  source: 'measured' | 'simulated';
  /** Asset ids from the root to this asset (inclusive), following causedBy links. */
  path: string[];
  reason: string;
}

/**
 * Explains, from subscribed rows only, why `assetId` is affected by each active
 * incident. Never invents a link: every hop is an `incident_asset.causedByAssetId`
 * and the dependency type comes from the `dependency` table.
 */
export function explainImpact(
  assetId: string,
  d: {
    incidents: readonly Incident[];
    incidentAssets: readonly { incidentId: bigint; assetId: string; impactType: string; impactStatus: string; causedByAssetId?: string | null }[];
    dependencies: readonly Dependency[];
    effects: readonly { incidentId: bigint; assetId: string; kind: string; phase: string }[];
    nameOf: (id: string) => string;
  }
): ImpactExplanation[] {
  const out: ImpactExplanation[] = [];
  for (const inc of d.incidents) {
    if (inc.status === 'resolved') continue;
    const rows = d.incidentAssets.filter(r => r.incidentId === inc.incidentId);
    const me = rows.find(r => r.assetId === assetId);
    const myEffects = d.effects.filter(e => e.incidentId === inc.incidentId && e.assetId === assetId && e.phase !== 'cleared');
    if (!me && myEffects.length === 0) continue;
    if (me && me.impactStatus === 'healthy' && me.impactType !== 'exposed' && myEffects.length === 0) continue;
    const source = inc.isSimulation ? 'simulated' : 'measured';
    if (myEffects.length > 0 || me?.impactType === 'direct') {
      const kinds = [...new Set(myEffects.map(e => e.kind))].join(', ') || 'root';
      out.push({
        incidentId: inc.incidentId,
        role: 'root',
        basis: 'confirmed',
        source,
        path: [assetId],
        reason: `Root cause of INC-${inc.incidentId}: a ${kinds} effect is recorded on this service${source === 'measured' ? ' from a physical sensor measurement' : ' by a synthetic scenario'}.`,
      });
      continue;
    }
    // Walk causedBy links back to a root (cycle-safe).
    const path = [assetId];
    const seen = new Set(path);
    let cur = me;
    while (cur && cur.causedByAssetId && !seen.has(cur.causedByAssetId)) {
      path.unshift(cur.causedByAssetId);
      seen.add(cur.causedByAssetId);
      cur = rows.find(r => r.assetId === cur!.causedByAssetId);
    }
    const via = me!.causedByAssetId ?? '';
    const dep = d.dependencies.find(x => x.dependentAssetId === assetId && x.requiredAssetId === via);
    const exposed = me!.impactType === 'exposed';
    out.push({
      incidentId: inc.incidentId,
      role: exposed ? 'exposed' : 'cascade',
      basis: 'modeled',
      source,
      path,
      reason: exposed
        ? `Modeled exposure: this service trusts ${d.nameOf(via)}${dep ? ` (${dep.dependencyType} dependency)` : ''}, which is affected. Not confirmed compromised.`
        : `Modeled impact: this service ${dep ? `has a ${dep.dependencyType} dependency on` : 'depends on'} ${d.nameOf(via)}, which is ${rows.find(r => r.assetId === via)?.impactStatus ?? 'affected'}. Predicted by the twin, not measured.`,
    });
  }
  return out;
}
