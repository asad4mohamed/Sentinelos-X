// Rules-based incident analysis — the deterministic fallback when NVIDIA Nemotron
// is unavailable. It is NOT a language model and never pretends to be one.
//
// Every statement is derived from subscribed SpacetimeDB rows with an explicit
// rule: recorded effects, evidence rows, sensor readings, the dependency graph and
// the module's own severity rule (severityFromBlast). It does not guess root
// causes, produce confidence scores, or write anything to the database.
import type { SentinelData } from '../hooks/useSentinelData';
import { buildLabInput } from './decisionLab';
import { computeBlastRadius, CONTAINMENT, evaluateAll, type Criticality, type DependencyType, type EffectKind, type EffectPhase, type StrategyResult } from './engine';

export const RULES_LABEL = 'Rules-based analysis — NVIDIA AI unavailable';
export const RULES_LABEL_CROSSCHECK = 'Rules-based analysis (deterministic, not AI)';

export interface RulesFinding {
  text: string;
  /** Where the statement comes from, so a reader can check it. */
  basis: string;
}

export interface RulesAnalysis {
  incidentId: bigint;
  title: string;
  kind: 'simulation' | 'real event';
  status: string;
  severity: string;
  observed: RulesFinding[];
  roots: { assetId: string; name: string; effects: string[] }[];
  modeledImpact: { assetId: string; name: string; state: string; via: string | null; depth: number }[];
  modeledExposure: { assetId: string; name: string; via: string | null }[];
  severityReasons: string[];
  responseOptions: { name: string; support: string; summary: string }[];
  missingEvidence: string[];
  limitations: string[];
}

const CRIT_TO_SEV: Record<Criticality, string> = { mission_critical: 'critical', high: 'high', medium: 'medium', low: 'low' };

export function rulesAnalysis(
  d: Pick<SentinelData, 'incidents' | 'assets' | 'dependencies' | 'effects' | 'evidence' | 'recoveries' | 'sensorNodes' | 'sensorReadings' | 'aiInvestigations'>,
  incidentId: bigint
): RulesAnalysis | null {
  const inc = d.incidents.find(i => i.incidentId === incidentId);
  if (!inc) return null;
  const nameOf = (id: string) => d.assets.find(a => a.assetId === id)?.name ?? id;
  const critOf = (id: string) => (d.assets.find(a => a.assetId === id)?.criticality ?? 'low') as Criticality;

  const live = d.effects.filter(e => e.incidentId === incidentId && e.phase !== 'cleared');
  const rootIds = [...new Set(live.map(e => e.assetId))].sort();
  const roots = rootIds.map(id => ({ assetId: id, name: nameOf(id), effects: live.filter(e => e.assetId === id).map(e => `${e.kind} (${e.level}, ${e.phase})`) }));

  const blast = computeBlastRadius(
    d.assets.map(a => a.assetId),
    d.dependencies.map(x => ({ dependentAssetId: x.dependentAssetId, requiredAssetId: x.requiredAssetId, dependencyType: x.dependencyType as DependencyType })),
    live.map(e => ({ assetId: e.assetId, kind: e.kind as EffectKind, level: e.level === 'offline' ? 'offline' : 'degraded', phase: e.phase as EffectPhase, intensity: e.intensity }))
  );
  const modeledImpact: RulesAnalysis['modeledImpact'] = [];
  const modeledExposure: RulesAnalysis['modeledExposure'] = [];
  const severityReasons: string[] = [];
  for (const b of [...blast.values()].sort((x, y) => x.depth - y.depth || x.assetId.localeCompare(y.assetId))) {
    if (b.role === 'none') continue;
    const c = critOf(b.assetId);
    if (b.role === 'dependent' && b.level !== 'healthy') modeledImpact.push({ assetId: b.assetId, name: nameOf(b.assetId), state: b.level, via: b.causedBy ? nameOf(b.causedBy) : null, depth: b.depth });
    if (b.exposed && b.role !== 'root') modeledExposure.push({ assetId: b.assetId, name: nameOf(b.assetId), via: b.exposureFrom ? nameOf(b.exposureFrom) : null });
    if (b.role === 'root' && b.health === 'critical') severityReasons.push(`Root ${nameOf(b.assetId)} is critical and ${c.replace('_', '-')} → at least ${CRIT_TO_SEV[c]}`);
    if (b.level === 'offline') severityReasons.push(`${nameOf(b.assetId)} (${c.replace('_', '-')}) is offline → at least ${c === 'mission_critical' ? 'critical' : c === 'high' ? 'high' : 'medium'}`);
    else if (b.level === 'degraded' && b.role === 'dependent') severityReasons.push(`${nameOf(b.assetId)} (${c.replace('_', '-')}) is degraded → at least ${c === 'mission_critical' ? 'high' : c === 'high' ? 'medium' : 'low'}`);
  }
  if (severityReasons.length === 0) severityReasons.push('No live impact remains, so no severity rule applies now.');

  // Observed facts: evidence rows (with their source), and real sensor readings.
  const ev = d.evidence.filter(e => e.incidentId === incidentId).sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1));
  const observed: RulesFinding[] = ev.slice(0, 12).map(e => ({ text: `${e.title} — ${nameOf(e.assetId)}`, basis: `E${e.evidenceId} · ${e.synthetic ? 'synthetic' : 'measured'} · ${e.kind}` }));
  const node = d.sensorNodes.find(n => n.activeIncidentId === incidentId || n.silentIncidentId === incidentId);
  if (node) {
    const readings = d.sensorReadings.filter(r => r.nodeId === node.nodeId);
    const last = readings[readings.length - 1];
    if (last) {
      const breach = last.tempC > node.tempLimitC || last.humidityPct > node.humidityLimitPct;
      observed.push({ text: `Latest physical reading ${last.tempC.toFixed(1)} °C / ${last.humidityPct.toFixed(0)}% (limits ${node.tempLimitC} °C / ${node.humidityLimitPct}%) — ${breach ? 'still above a limit' : 'back within limits'}`, basis: `sensor ${node.nodeId} · measured` });
    }
  }

  const missingEvidence: string[] = [];
  if (ev.length === 0) missingEvidence.push('No evidence rows are recorded for this incident.');
  if (!inc.isSimulation && !ev.some(e => !e.synthetic)) missingEvidence.push('This is a real event but no measured evidence is recorded.');
  if (inc.isSimulation) missingEvidence.push('All evidence is synthetic (simulation); nothing here was observed on real systems.');
  if (modeledImpact.length + modeledExposure.length > 0) missingEvidence.push('Downstream impact is predicted from the dependency model only — no service-level telemetry confirms it.');
  if (!inc.isSimulation && node) missingEvidence.push('The sensor measures temperature/humidity only; it cannot show whether infrastructure was actually affected.');
  const lastAi = d.aiInvestigations.filter(i => i.incidentId === incidentId).sort((a, b) => (a.investigationId < b.investigationId ? 1 : -1))[0];
  if (!lastAi || lastAi.status !== 'completed') missingEvidence.push('No completed AI investigation for this incident.');

  let responseOptions: RulesAnalysis['responseOptions'] = [];
  const target = rootIds.includes(inc.initialAssetId) ? inc.initialAssetId : rootIds[0];
  if (target && inc.status !== 'resolved') {
    const input = buildLabInput(d as SentinelData, incidentId, target);
    try {
      if (input) responseOptions = evaluateAll(input).results.map(r => ({ name: r.name, support: r.support, summary: optionSummary(r, nameOf) }));
    } catch {
      responseOptions = [];
    }
  }
  const containable = live.filter(e => e.phase === 'active' && CONTAINMENT[e.kind as EffectKind]);
  if (containable.length) {
    responseOptions.unshift({ name: `Containment available: ${[...new Set(containable.map(e => CONTAINMENT[e.kind as EffectKind]!.label))].join('; ')}`, support: 'executable', summary: 'Any registered responder can apply it from the incident page.' });
  }

  return {
    incidentId,
    title: inc.title,
    kind: inc.isSimulation ? 'simulation' : 'real event',
    status: inc.status,
    severity: inc.severity,
    observed,
    roots,
    modeledImpact,
    modeledExposure,
    severityReasons: [...new Set(severityReasons)],
    responseOptions,
    missingEvidence,
    limitations: [
      'Deterministic rules over recorded data — no language model was used.',
      'Does not determine root cause or attacker intent; it reports where effects are recorded.',
      'No probabilities or confidence scores are produced.',
      'Recommendations still require the normal human approval workflow; nothing is executed.',
    ],
  };
}

function optionSummary(r: StrategyResult, nameOf: (id: string) => string): string {
  const parts = [`restores ${r.restored.length}`, `makes ${r.disrupted.length} worse`, `${r.stillAffected.length} still affected`, `modeled severity ${r.before.severity} → ${r.after.severity}`];
  const unmet = r.preconditions.filter(p => !p.met).map(p => p.text);
  if (unmet.length) parts.push(`unmet: ${unmet.join('; ')}`);
  if (r.disrupted.length) parts.push(`worse: ${r.disrupted.map(nameOf).join(', ')}`);
  return parts.join(' · ');
}
