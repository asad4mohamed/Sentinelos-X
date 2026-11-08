// Attack-path explanation, rules-based fallback, incident report, Decision Lab pick.
// Data comes from fixtures/load.ts (rows produced by the real module reducers).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Identity } from 'spacetimedb';
import { loadScenario, scenarioIdentityHex } from './fixtures/load';
import { SentinelDataContext, type SentinelData } from '../hooks/useSentinelData';
import { ToastProvider } from '../components/Toast';
import { explainImpact } from '../lib/derive';
import { RULES_LABEL, RULES_LABEL_CROSSCHECK, rulesAnalysis } from '../lib/rulesAnalysis';
import { buildIncidentReport, reportHtml } from '../lib/report';
import { buildLabInput } from '../lib/decisionLab';
import { evaluateAll } from '../lib/engine';
import { RulesAnalysisPanel } from '../features/ai-investigator/RulesAnalysisPanel';
import { DecisionLabPage } from '../features/decision-lab/DecisionLabPage';

vi.mock('spacetimedb/react', () => ({
  useSpacetimeDB: () => ({ isActive: true, identity: Identity.fromString(scenarioIdentityHex), connectionId: undefined, connectionError: undefined, getConnection: () => null }),
  useTable: () => [[], true],
}));
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const inc = (d: SentinelData, s: string) => d.incidents.find(i => i.scenarioType === s)!;
const wrap = (d: SentinelData, ui: React.ReactNode, path = '/') =>
  render(
    <ToastProvider>
      <SentinelDataContext.Provider value={d}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/lab/:incidentId" element={<DecisionLabPage />} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </SentinelDataContext.Provider>
    </ToastProvider>
  );

describe('attack-path explanation (Digital Twin)', () => {
  it('root is confirmed, dependents are modeled with a real dependency path', () => {
    const d = loadScenario();
    const db = inc(d, 'database_outage');
    const args = { incidents: d.incidents, incidentAssets: d.incidentAssets, dependencies: d.dependencies, effects: d.effects, nameOf: (id: string) => id };
    const root = explainImpact('primary-db', args).find(x => x.incidentId === db.incidentId)!;
    expect(root).toMatchObject({ role: 'root', basis: 'confirmed', source: 'simulated' });
    const dep = explainImpact('customer-portal', args).find(x => x.incidentId === db.incidentId)!;
    expect(dep.basis).toBe('modeled');
    expect(dep.path[0]).toBe('primary-db');
    expect(dep.path.at(-1)).toBe('customer-portal');
    // every hop is a real dependency edge
    for (let i = 1; i < dep.path.length; i++) expect(d.dependencies.some(e => e.dependentAssetId === dep.path[i] && e.requiredAssetId === dep.path[i - 1])).toBe(true);
    expect(dep.reason).toMatch(/not measured/);
  });

  it('auth compromise exposure is labeled modeled, not confirmed compromised', () => {
    const d = loadScenario();
    // Fixture's auth incident is already contained (no exposure left), so model an uncontained one.
    const auth = { ...inc(d, 'auth_compromise'), status: 'open' };
    const rows = [...d.incidentAssets.filter(r => r.incidentId !== auth.incidentId), { incidentId: auth.incidentId, assetId: 'payment-svc', impactType: 'exposed', impactStatus: 'healthy', causedByAssetId: 'auth-svc' }];
    const x = explainImpact('payment-svc', { incidents: [auth], incidentAssets: rows, dependencies: d.dependencies, effects: d.effects, nameOf: id => id }).find(e => e.incidentId === auth.incidentId)!;
    expect(x.role).toBe('exposed');
    expect(x.reason).toMatch(/Not confirmed compromised/);
  });

  it('healthy, unrelated services get no explanation', () => {
    const d = loadScenario();
    expect(explainImpact('backup-vault', { incidents: [], incidentAssets: d.incidentAssets, dependencies: d.dependencies, effects: d.effects, nameOf: id => id })).toEqual([]);
  });
});

describe('rules-based fallback', () => {
  it('analyzes recorded data without inventing confidence or root causes', () => {
    const d = loadScenario();
    const a = rulesAnalysis(d, inc(d, 'database_outage').incidentId)!;
    expect(a.roots.map(r => r.assetId)).toEqual(['primary-db']);
    expect(a.modeledImpact.length).toBeGreaterThan(0);
    expect(a.severityReasons.join(' ')).toMatch(/Primary Database .*offline → at least critical/);
    expect(a.missingEvidence.join(' ')).toMatch(/synthetic/);
    expect(a.responseOptions.length).toBeGreaterThan(0);
    // Recorded evidence text may legitimately contain percentages; check only text the rules generate.
    expect(JSON.stringify([a.severityReasons, a.responseOptions, a.missingEvidence, a.modeledImpact])).not.toMatch(/\d\s*%(?! \()|probab|confidence score/i);
  });

  it('returns null for a missing incident and handles empty evidence', () => {
    const d = loadScenario();
    expect(rulesAnalysis(d, 999999n)).toBeNull();
    const a = rulesAnalysis({ ...d, evidence: [] }, inc(d, 'database_outage').incidentId)!;
    expect(a.observed).toEqual([]);
    expect(a.missingEvidence[0]).toMatch(/No evidence rows/);
  });

  it('auto-shows with the fallback label when no agent is available', () => {
    const d = { ...loadScenario(), services: [] };
    wrap(d, <RulesAnalysisPanel incident={inc(d, 'database_outage')} />);
    expect(screen.getByText(RULES_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/not produced by NVIDIA Nemotron or any language model/)).toBeInTheDocument();
    expect(screen.getByTestId('rules-analysis')).toBeInTheDocument();
  });

  it('is collapsed and labeled as a cross-check when the agent is online', () => {
    const base = loadScenario();
    const agent = { identity: Identity.fromString('0'.repeat(64)), name: 'Nemotron Investigator', kind: 'ai_agent', status: 'authorized', online: true } as unknown as SentinelData['services'][number];
    const d = { ...base, services: [agent], aiInvestigations: [] };
    wrap(d, <RulesAnalysisPanel incident={inc(d, 'database_outage')} />);
    expect(screen.getByText(RULES_LABEL_CROSSCHECK)).toBeInTheDocument();
    expect(screen.queryByTestId('rules-analysis')).toBeNull();
  });

  it('auto-shows when the last investigation failed (e.g. invalid key / rate limit)', () => {
    const base = loadScenario();
    const db = inc(base, 'database_outage');
    const agent = { identity: Identity.fromString('0'.repeat(64)), name: 'Nemotron Investigator', kind: 'ai_agent', status: 'authorized', online: true } as unknown as SentinelData['services'][number];
    const failed = { investigationId: 77n, incidentId: db.incidentId, status: 'failed', model: 'm', error: 'NVIDIA API 401 (API key rejected)', summary: undefined, requestedAt: db.createdAt, requestedBy: agent.identity } as unknown as SentinelData['aiInvestigations'][number];
    wrap({ ...base, services: [agent], aiInvestigations: [failed] }, <RulesAnalysisPanel incident={db} />);
    expect(screen.getByText(RULES_LABEL)).toBeInTheDocument();
    expect(screen.getByText(/API key rejected/)).toBeInTheDocument();
  });
});

describe('incident report export', () => {
  it('reflects the actual record and labels provenance', () => {
    const d = loadScenario();
    const db = inc(d, 'database_outage');
    const md = buildIncidentReport(d, db.incidentId, new Date('2026-11-08T12:00:00Z'))!;
    expect(md).toMatch(new RegExp(`# SentinelOS X — Incident Report INC-${db.incidentId}`));
    expect(md).toMatch(/SIMULATION \(synthetic scenario\)/);
    expect(md).toMatch(/\| Primary Database \| confirmed root \|/);
    expect(md).toMatch(/modeled impact/);
    expect(md).toMatch(/\| E\d+ \| synthetic \|/);
    expect(md).toMatch(/### Investigation #\d+ — completed/);
    expect(md).toMatch(/Provider\/model: /);
    expect(md).toMatch(/AI-generated/);
    expect(buildIncidentReport(d, inc(d, 'traffic_surge').incidentId)!).toMatch(/_No AI investigation was run._/);
    expect(md).toMatch(/## Decision Lab/);
    expect(md).toMatch(/★ Engine pick/);
    expect(md).toMatch(/## Timeline/);
    for (const e of d.evidence.filter(x => x.incidentId === db.incidentId)) expect(md).toContain(`E${e.evidenceId}`);
  });

  it('returns null for a missing incident; HTML escapes content', () => {
    const d = loadScenario();
    expect(buildIncidentReport(d, 424242n)).toBeNull();
    const html = reportHtml('# T <script>x</script>\n\n| a | b |\n|---|---|\n| 1 | **2** |', 'T');
    expect(html).not.toMatch(/<script>x/);
    expect(html).toMatch(/<td><strong>2<\/strong><\/td>/);
  });
});

describe('Decision Lab safety and pick', () => {
  it('repeated previews never mutate authoritative rows', () => {
    const d = loadScenario();
    const db = inc(d, 'database_outage');
    const snapshot = JSON.stringify({ e: d.effects, a: d.assets, i: d.incidents, r: d.recoveries }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (let i = 0; i < 5; i++) evaluateAll(buildLabInput(d, db.incidentId, 'primary-db')!);
    wrap(d, null, `/lab/${db.incidentId}`);
    expect(JSON.stringify({ e: d.effects, a: d.assets, i: d.incidents, r: d.recoveries }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshot);
  });

  it('shows the engine pick and the hypothetical banner', () => {
    const d = loadScenario();
    wrap(d, null, `/lab/${inc(d, 'database_outage').incidentId}`);
    expect(screen.getByText(/All results below are hypothetical projections/)).toBeInTheDocument();
    expect(screen.getByText('★ Engine pick')).toBeInTheDocument();
  });
});
