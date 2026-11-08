// Blast-radius view model derived from AUTHORITATIVE rows (incident_asset,
// incident_effect, dependency). Pure; nothing here decides impact — it only
// groups and explains what the SpacetimeDB engine wrote.
import type { Asset, Dependency, IncidentAsset, IncidentEffect } from '../types/domain';

export type BlastGroup = 'root' | 'direct' | 'indirect' | 'exposed';

export interface BlastEntry {
  assetId: string;
  name: string;
  group: BlastGroup;
  status: string; // offline | degraded | exposed | recovering | recovered
  depth: number;
  causedBy: string | null;
  via: string | null;
  criticality: string;
  reason: string;
  /** Root → … → this asset, following recorded causes. */
  path: string[];
  current: boolean;
}

export interface BlastSummary {
  entries: BlastEntry[];
  total: number;
  root: number;
  direct: number;
  indirect: number;
  exposed: number;
  maxDepth: number;
  criticalAffected: BlastEntry[];
}

const EFFECT_REASON: Record<string, string> = {
  outage: 'Confirmed outage (root cause)',
  fault: 'Injected fault (root cause)',
  overload: 'Abnormal synthetic load (root cause)',
  compromise: 'Confirmed compromise (root cause)',
  integrity: 'File-integrity violation (root cause)',
};

export function groupOf(r: Pick<IncidentAsset, 'impactType' | 'impactStatus' | 'depth'>): BlastGroup {
  if (r.impactType === 'direct') return 'root';
  if (r.impactStatus === 'exposed') return 'exposed';
  return r.depth <= 1 ? 'direct' : 'indirect';
}

export function deriveBlast(
  incidentId: bigint,
  incidentAssets: readonly IncidentAsset[],
  effects: readonly IncidentEffect[],
  dependencies: readonly Dependency[],
  assetById: Map<string, Asset>,
  includeRecovered = false
): BlastSummary {
  const rows = incidentAssets.filter(r => r.incidentId === incidentId && (includeRecovered || r.impactStatus !== 'recovered'));
  const byAsset = new Map(rows.map(r => [r.assetId, r]));
  const edgeType = (dependent: string, required: string) => dependencies.find(d => d.dependentAssetId === dependent && d.requiredAssetId === required)?.dependencyType ?? null;
  const name = (id: string) => assetById.get(id)?.name ?? id;

  const entries: BlastEntry[] = rows.map(r => {
    const group = groupOf(r);
    const causedBy = r.causedByAssetId ?? null;
    const via = causedBy ? edgeType(r.assetId, causedBy) : null;
    let reason: string;
    if (group === 'root') {
      const kind = effects.find(e => e.incidentId === incidentId && e.assetId === r.assetId)?.kind ?? 'fault';
      reason = EFFECT_REASON[kind] ?? 'Root cause';
    } else if (group === 'exposed') {
      reason = `Trusts ${name(causedBy ?? '')} (${via ?? 'dependency'} edge) — potentially exposed, not confirmed`;
    } else {
      const status = byAsset.get(causedBy ?? '')?.impactStatus ?? 'impacted';
      reason = `${via ?? 'Dependency'} dependency on ${name(causedBy ?? '')} (${status})`;
    }
    // Walk recorded causes back to the root (bounded; cycles cannot loop forever).
    const path = [r.assetId];
    let cur = causedBy;
    for (let i = 0; cur && i < rows.length + 1 && !path.includes(cur); i++) {
      path.unshift(cur);
      cur = byAsset.get(cur)?.causedByAssetId ?? null;
    }
    return {
      assetId: r.assetId,
      name: name(r.assetId),
      group,
      status: r.impactStatus,
      depth: r.depth,
      causedBy,
      via,
      criticality: assetById.get(r.assetId)?.criticality ?? 'low',
      reason,
      path,
      current: r.impactStatus !== 'recovered',
    };
  });

  const order: Record<BlastGroup, number> = { root: 0, direct: 1, indirect: 2, exposed: 3 };
  entries.sort((a, b) => order[a.group] - order[b.group] || a.depth - b.depth || a.name.localeCompare(b.name));
  const current = entries.filter(e => e.current);
  const count = (g: BlastGroup) => current.filter(e => e.group === g).length;
  return {
    entries,
    total: current.length,
    root: count('root'),
    direct: count('direct'),
    indirect: count('indirect'),
    exposed: count('exposed'),
    maxDepth: current.reduce((m, e) => Math.max(m, e.depth), 0),
    criticalAffected: current.filter(e => e.criticality === 'mission_critical' || e.criticality === 'high'),
  };
}

/** Edge classification for the twin graph, derived from asset rows or one incident's rows. */
export type EdgeClass = 'normal' | 'direct' | 'indirect' | 'exposure';

export function classifyEdge(
  dependent: { status: string | null; causedBy: string | null; exposedFrom: string | null },
  requiredId: string,
  requiredIsRoot: boolean,
  requiredImpacted: boolean
): EdgeClass {
  if (dependent.causedBy === requiredId && dependent.status && dependent.status !== 'exposed' && requiredImpacted) return requiredIsRoot ? 'direct' : 'indirect';
  if (dependent.exposedFrom === requiredId) return 'exposure';
  return 'normal';
}
