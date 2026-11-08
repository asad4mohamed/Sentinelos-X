// Decision Lab page, rendered with rows produced by the real module reducers
// (fixtures/load.ts). The SpacetimeDB hook is stubbed: no live server here.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Identity } from 'spacetimedb';
import { loadScenario, scenarioIdentityHex } from './fixtures/load';
import { SentinelDataContext, type SentinelData } from '../hooks/useSentinelData';
import { ToastProvider } from '../components/Toast';
import { DecisionLabPage } from '../features/decision-lab/DecisionLabPage';
import { buildLabInput, splitCitations } from '../lib/decisionLab';
import { evaluateAll } from '../lib/engine';

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

function renderLab(path: string, data: SentinelData = loadScenario()) {
  return render(
    <ToastProvider>
      <SentinelDataContext.Provider value={data}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/lab" element={<DecisionLabPage />} />
            <Route path="/lab/:incidentId" element={<DecisionLabPage />} />
          </Routes>
        </MemoryRouter>
      </SentinelDataContext.Provider>
    </ToastProvider>
  );
}

const incidentOf = (d: SentinelData, scenario: string) => d.incidents.find(i => i.scenarioType === scenario)!;

describe('Decision Lab page', () => {
  it('compares four strategies for the database outage and labels failover as hypothetical', () => {
    const d = loadScenario();
    const inc = incidentOf(d, 'database_outage');
    renderLab(`/lab/${inc.incidentId}`, d);
    const cards = screen.getByRole('region', { name: 'Strategy comparison' });
    for (const name of ['Isolate the affected service', 'Restore the service (approved recovery)', 'Fail over to a standby', 'Staged containment, then recovery']) {
      expect(within(cards).getByText(name)).toBeInTheDocument();
    }
    fireEvent.click(within(cards).getByText('Fail over to a standby'));
    expect(screen.getAllByText(/Hypothetical \(modeled\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/no failover operation/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Now \(authoritative state\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Propose This Response/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Explain with Nemotron/ })).toBeInTheDocument();
  });

  it('shows evidence ids and a truthful degraded state when no agent is authorized', () => {
    const d = loadScenario();
    const inc = incidentOf(d, 'auth_compromise');
    renderLab(`/lab/${inc.incidentId}`, { ...d, services: [] });
    expect(screen.getByText(/Nemotron agent is not connected/)).toBeInTheDocument();
    expect(screen.getByText(/does not depend on AI/)).toBeInTheDocument();
    expect(screen.getAllByText(/^E\d+$/).length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no open incidents', () => {
    const d = loadScenario();
    renderLab('/lab', { ...d, incidents: d.incidents.map(i => ({ ...i, status: 'resolved' })) });
    expect(screen.getByText(/No open incidents to compare responses for/)).toBeInTheDocument();
  });

  it('reports an unknown incident id instead of crashing', () => {
    renderLab('/lab/987654');
    expect(screen.getByText(/Incident 987654 not found/)).toBeInTheDocument();
  });

  it('preview computed from subscribed rows matches the engine and carries a fingerprint', () => {
    const d = loadScenario();
    const inc = incidentOf(d, 'database_outage');
    const input = buildLabInput(d, inc.incidentId, inc.initialAssetId)!;
    const r = evaluateAll(input);
    expect(r.fingerprint).toMatch(/^\w+-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(r.results.map(x => x.strategy)).toEqual(['isolate', 'restore', 'failover', 'staged']);
  });

  it('splits evidence citations', () => {
    expect(splitCitations('Root is DB [E12] and auth [E7].')).toEqual([
      { kind: 'text', value: 'Root is DB ' },
      { kind: 'cite', id: '12' },
      { kind: 'text', value: ' and auth ' },
      { kind: 'cite', id: '7' },
      { kind: 'text', value: '.' },
    ]);
  });
});
