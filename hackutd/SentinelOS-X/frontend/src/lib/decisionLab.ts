// Builds the Decision Lab engine input from SUBSCRIBED (authoritative) rows.
// The preview runs in the browser for responsiveness and is labelled as a
// preview; anything shared goes through propose_response, which recomputes the
// same engine server-side and rejects a stale fingerprint.
import type { SentinelData } from '../hooks/useSentinelData';
import type { Criticality, DependencyType, EffectKind, EffectPhase, LabInput } from './engine';

export function buildLabInput(d: Pick<SentinelData, 'assets' | 'dependencies' | 'effects' | 'incidents' | 'recoveries'>, incidentId: bigint, targetAssetId: string): LabInput | null {
  const inc = d.incidents.find(i => i.incidentId === incidentId);
  if (!inc) return null;
  return {
    incidentId: String(incidentId),
    incidentStatus: inc.status,
    assets: d.assets.map(a => ({ assetId: a.assetId, name: a.name, criticality: a.criticality as Criticality })),
    edges: d.dependencies.map(e => ({ dependentAssetId: e.dependentAssetId, requiredAssetId: e.requiredAssetId, dependencyType: e.dependencyType as DependencyType })),
    effects: d.effects
      .filter(e => e.phase !== 'cleared')
      .map(e => ({ incidentId: String(e.incidentId), assetId: e.assetId, kind: e.kind as EffectKind, level: e.level === 'offline' ? 'offline' : 'degraded', phase: e.phase as EffectPhase, intensity: e.intensity })),
    targetAssetId,
    pendingRecoveryAssetIds: d.recoveries.filter(r => r.incidentId === incidentId && r.status === 'pending').map(r => r.assetId),
  };
}

/** Evidence citations in explanation text look like [E12]. */
export function splitCitations(text: string): ({ kind: 'text'; value: string } | { kind: 'cite'; id: string })[] {
  const out: ({ kind: 'text'; value: string } | { kind: 'cite'; id: string })[] = [];
  const re = /\[E(\d{1,12})\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    out.push({ kind: 'cite', id: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}
