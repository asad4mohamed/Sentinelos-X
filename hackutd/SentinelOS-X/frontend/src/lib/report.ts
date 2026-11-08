// Incident report export — built entirely in the browser from subscribed
// SpacetimeDB rows. It reports what is recorded; missing sections say so.
// Formats: Markdown (.md) and a self-contained printable HTML (.html → Print → PDF).
import type { SentinelData } from '../hooks/useSentinelData';
import { fmtDateTime } from './format';
import { buildLabInput } from './decisionLab';
import { evaluateAll, recommend, STRATEGY_NAME, type StrategyId } from './engine';
import { RULES_LABEL, RULES_LABEL_CROSSCHECK, rulesAnalysis } from './rulesAnalysis';

type Data = Pick<
  SentinelData,
  | 'incidents' | 'assets' | 'dependencies' | 'effects' | 'evidence' | 'recoveries' | 'sensorNodes' | 'sensorReadings' | 'aiInvestigations' | 'aiFindings'
  | 'incidentAssets' | 'events' | 'decisions' | 'responders' | 'proposals' | 'explanations' | 'services'
>;

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function buildIncidentReport(d: Data, incidentId: bigint, generatedAt: Date = new Date()): string | null {
  const inc = d.incidents.find(i => i.incidentId === incidentId);
  if (!inc) return null;
  const nameOf = (id: string) => d.assets.find(a => a.assetId === id)?.name ?? id;
  const who = (hex: string | undefined) => (hex ? (d.responders.find(r => r.identity.toHexString() === hex)?.displayName ?? d.services.find(s => s.identity.toHexString() === hex)?.name ?? `${hex.slice(0, 10)}…`) : '—');
  const L: string[] = [];
  const kind = inc.isSimulation ? 'SIMULATION (synthetic scenario)' : 'REAL EVENT (physical sensor measurement)';

  L.push(`# SentinelOS X — Incident Report INC-${incidentId}`, '');
  L.push(`> Generated ${generatedAt.toISOString()} from live SpacetimeDB state. Sections with no recorded data say so; nothing is filled in.`, '');
  L.push('## Summary', '');
  L.push('| Field | Value |', '|---|---|');
  L.push(`| Identifier | INC-${incidentId} |`);
  L.push(`| Title | ${esc(inc.title)} |`);
  L.push(`| Type | ${kind} — scenario \`${inc.scenarioType}\` |`);
  L.push(`| Severity | ${inc.severity} |`);
  L.push(`| Status | ${inc.status} |`);
  L.push(`| Root service | ${esc(nameOf(inc.initialAssetId))} (\`${inc.initialAssetId}\`) |`);
  L.push(`| Created | ${fmtDateTime(inc.createdAt)} |`);
  L.push(`| Last updated | ${fmtDateTime(inc.updatedAt)} |`);
  L.push(`| Resolved | ${inc.resolvedAt ? fmtDateTime(inc.resolvedAt) : 'not resolved'} |`);
  if (inc.resolutionSummary) L.push(`| Resolution | ${esc(inc.resolutionSummary)} |`);
  L.push('');
  if (inc.description) L.push(inc.description, '');

  L.push('## Data provenance', '');
  L.push('- **Measured**: physical DHT11 readings and evidence marked `measured`.');
  L.push('- **Synthetic**: simulated scenarios, telemetry and evidence marked `synthetic`. The 16-service infrastructure is a modeled digital twin.');
  L.push('- **Modeled**: impact on dependent services is predicted from the dependency graph, not observed.');
  L.push('- **AI-generated**: Nemotron text is labeled and is never the source of a result.', '');

  L.push('## Affected services', '');
  const rows = d.incidentAssets.filter(r => r.incidentId === incidentId).sort((a, b) => a.depth - b.depth || a.assetId.localeCompare(b.assetId));
  if (rows.length === 0) L.push('_No affected services recorded._', '');
  else {
    L.push('| Service | Basis | Current | Peak | Via | Hop |', '|---|---|---|---|---|---|');
    for (const r of rows) {
      const basis = r.impactType === 'direct' ? 'confirmed root' : r.impactType === 'exposed' ? 'modeled exposure' : 'modeled impact';
      L.push(`| ${esc(nameOf(r.assetId))} | ${basis} | ${r.impactStatus} | ${r.peakStatus} | ${r.causedByAssetId ? esc(nameOf(r.causedByAssetId)) : '—'} | ${r.depth} |`);
    }
    L.push('');
  }

  L.push('## Evidence', '');
  const ev = d.evidence.filter(e => e.incidentId === incidentId).sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1));
  if (ev.length === 0) L.push('_No evidence recorded._', '');
  else {
    L.push('| ID | Source | Service | Observed | Title | Detail |', '|---|---|---|---|---|---|');
    for (const e of ev) L.push(`| E${e.evidenceId} | ${e.synthetic ? 'synthetic' : '**measured**'} | ${esc(nameOf(e.assetId))} | ${fmtDateTime(e.observedAt)} | ${esc(e.title)} | ${esc(e.detail).slice(0, 240)} |`);
    L.push('');
  }

  const node = d.sensorNodes.find(n => n.activeIncidentId === incidentId || n.silentIncidentId === incidentId);
  if (!inc.isSimulation || node) {
    L.push('## Physical sensor readings', '');
    const nodes = node ? [node] : d.sensorNodes;
    const readings = d.sensorReadings.filter(r => nodes.some(n => n.nodeId === r.nodeId)).slice(-12);
    if (readings.length === 0) L.push('_No sensor readings available in the client._', '');
    else {
      const n = nodes[0]!;
      L.push(`Node \`${n.nodeId}\` (${n.sensorModel}), limits ${n.tempLimitC} °C / ${n.humidityLimitPct}% — measured values:`, '');
      L.push('| Time | Temp °C | Humidity % |', '|---|---|---|');
      for (const r of readings) L.push(`| ${fmtDateTime(r.timestamp)} | ${r.tempC.toFixed(1)} | ${r.humidityPct.toFixed(0)} |`);
      L.push('');
    }
  }

  L.push('## AI investigation (NVIDIA Nemotron)', '');
  const invs = d.aiInvestigations.filter(i => i.incidentId === incidentId).sort((a, b) => (a.investigationId < b.investigationId ? -1 : 1));
  if (invs.length === 0) L.push('_No AI investigation was run._', '');
  for (const i of invs) {
    L.push(`### Investigation #${i.investigationId} — ${i.status}`, '');
    L.push(`Provider/model: ${i.model || 'not claimed'} · requested ${fmtDateTime(i.requestedAt)} by ${who(i.requestedBy.toHexString())}${i.completedAt ? ` · completed ${fmtDateTime(i.completedAt)}` : ''}`, '');
    if (i.summary) L.push(`> AI-generated summary: ${i.summary.replace(/\n+/g, ' ')}`, '');
    if (i.error) L.push(`Error: ${i.error}`, '');
    const fs = d.aiFindings.filter(f => f.investigationId === i.investigationId);
    for (const f of fs) L.push(`- **${f.kind}** (${f.confidence} confidence, as stated by the model; approval: ${f.approvalStatus}): ${f.summary.replace(/\n+/g, ' ')}${f.evidence ? ` — evidence: ${f.evidence.replace(/\n+/g, ' ')}` : ''}`);
    if (fs.length) L.push('');
  }

  const ra = rulesAnalysis(d, incidentId);
  if (ra) {
    const aiOk = d.services.some(s => s.kind === 'ai_agent' && s.status === 'authorized' && s.online) && invs.at(-1)?.status !== 'failed';
    L.push(`## ${aiOk ? RULES_LABEL_CROSSCHECK : RULES_LABEL}`, '');
    L.push('Severity rules that apply now:', '');
    for (const r of ra.severityReasons) L.push(`- ${r}`);
    L.push('', 'Missing evidence:', '');
    for (const m of ra.missingEvidence) L.push(`- ${m}`);
    L.push('', 'Limitations:', '');
    for (const m of ra.limitations) L.push(`- ${m}`);
    L.push('');
  }

  L.push('## Decision Lab', '');
  const props = d.proposals.filter(p => p.incidentId === incidentId).sort((a, b) => (a.proposalId < b.proposalId ? -1 : 1));
  const target = d.effects.some(e => e.incidentId === incidentId && e.phase !== 'cleared' && e.assetId === inc.initialAssetId)
    ? inc.initialAssetId
    : d.effects.find(e => e.incidentId === incidentId && e.phase !== 'cleared')?.assetId;
  if (target && inc.status !== 'resolved') {
    try {
      const report = evaluateAll(buildLabInput(d as SentinelData, incidentId, target)!);
      const rec = recommend(report, nameOf);
      L.push(`Current comparison for ${nameOf(target)} (hypothetical projections on the modeled twin):`, '');
      L.push('| Strategy | Support | Restored | Made worse | Still affected | Modeled severity |', '|---|---|---|---|---|---|');
      for (const r of report.results) L.push(`| ${r.name}${rec?.strategy === r.strategy ? ' ★' : ''} | ${r.support} | ${r.restored.length} | ${r.disrupted.length} | ${r.stillAffected.length} | ${r.before.severity} → ${r.after.severity} |`);
      L.push('');
      if (rec) L.push(`★ Engine pick (deterministic ranking, not an order): ${rec.rationale}`, '');
    } catch {
      L.push('_Comparison unavailable for the current state._', '');
    }
  } else L.push('_No live root effect — no comparison to show._', '');
  if (props.length) {
    L.push('Proposals:', '');
    for (const p of props) L.push(`- #${p.proposalId} ${STRATEGY_NAME[p.strategy as StrategyId] ?? p.strategy} [${p.support}] — **${p.status}**; proposed by ${p.proposerName} ${fmtDateTime(p.createdAt)}${p.decidedBy ? `; decided by ${who(p.decidedBy.toHexString())} ${fmtDateTime(p.decidedAt)}` : ''}. ${p.summary}`);
    L.push('');
  }
  const xs = d.explanations.filter(x => x.incidentId === incidentId && x.status === 'completed');
  for (const x of xs) L.push(`> AI-generated explanation #${x.explanationId} (${x.model}): ${(x.text ?? '').replace(/\n+/g, ' ')}`, '');

  L.push('## Approvals, containment and recovery', '');
  const recs = d.recoveries.filter(r => r.incidentId === incidentId).sort((a, b) => (a.recoveryId < b.recoveryId ? -1 : 1));
  if (recs.length === 0) L.push('_No recovery requests._', '');
  else {
    L.push('| Recovery | Service | Status | Requested by | Requested | Decided by | Decided |', '|---|---|---|---|---|---|---|');
    for (const r of recs) L.push(`| #${r.recoveryId} | ${esc(nameOf(r.assetId))} | ${r.status} | ${who(r.requestedBy.toHexString())} | ${fmtDateTime(r.requestedAt)} | ${who(r.decidedBy?.toHexString())} | ${r.decidedAt ? fmtDateTime(r.decidedAt) : '—'} |`);
    L.push('', '_Two-person rule: the requester cannot approve their own recovery (enforced server-side)._', '');
  }
  const decs = d.decisions.filter(x => x.incidentId === incidentId).sort((a, b) => (a.decisionId < b.decisionId ? -1 : 1));
  if (decs.length) {
    L.push('Decisions:', '');
    for (const x of decs) L.push(`- ${fmtDateTime(x.createdAt)} — ${x.actorName} (${x.actorRole}): ${x.summary}`);
    L.push('');
  }

  L.push('## Timeline (audit of committed state changes)', '');
  const evs = d.events.filter(e => e.incidentId === incidentId).sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  if (evs.length === 0) L.push('_No timeline events._', '');
  else {
    L.push('| Time | Event | Actor | Description |', '|---|---|---|---|');
    for (const e of evs) L.push(`| ${fmtDateTime(e.timestamp)} | ${e.eventType} | ${esc(e.actorName || 'system')} | ${esc(e.description)} |`);
    L.push('');
  }
  L.push('---', `SentinelOS X · HackUTD 2026 · Final status: **${inc.status}**`);
  return L.join('\n');
}

/** Minimal Markdown → HTML for the report's own constructs (headings, tables, lists, quotes, bold, code). */
export function reportHtml(md: string, title: string): string {
  const escH = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => escH(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/_(.+?)_/g, '<em>$1</em>').replace(/\\\|/g, '|');
  const out: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!);
      i--;
      const cells = (r: string) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
      out.push('<table><thead><tr>' + cells(rows[0]!).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows.slice(2)) out.push('<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
    } else if (l.startsWith('### ')) out.push(`<h3>${inline(l.slice(4))}</h3>`);
    else if (l.startsWith('## ')) out.push(`<h2>${inline(l.slice(3))}</h2>`);
    else if (l.startsWith('# ')) out.push(`<h1>${inline(l.slice(2))}</h1>`);
    else if (l.startsWith('> ')) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
    else if (l.startsWith('- ')) {
      out.push('<ul>');
      while (i < lines.length && lines[i]!.startsWith('- ')) out.push(`<li>${inline(lines[i++]!.slice(2))}</li>`);
      i--;
      out.push('</ul>');
    } else if (l === '---') out.push('<hr>');
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)}</title><style>
body{font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#111;max-width:960px;margin:24px auto;padding:0 16px;background:#fff}
h1{font-size:22px;border-bottom:3px solid #0e7490;padding-bottom:6px}h2{font-size:17px;margin-top:24px;color:#0e7490}h3{font-size:15px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12.5px}th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f1f5f9}
blockquote{border-left:4px solid #94a3b8;margin:8px 0;padding:4px 10px;color:#334155;background:#f8fafc}code{background:#f1f5f9;padding:0 3px;border-radius:3px}
@media print{body{margin:0}h2{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}}
</style></head><body>${out.join('\n')}</body></html>`;
}

export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
