// Render tests: every page is rendered with rows produced by the real module
// reducers and scheduler tick (see fixtures/load.ts). The SpacetimeDB connection
// hook is stubbed because no server runs inside unit tests — these tests do NOT
// prove a live database connection.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Identity, Timestamp } from 'spacetimedb';
import { loadScenario, scenarioIdentityHex } from './fixtures/load';
import { SentinelDataContext, type SentinelData } from '../hooks/useSentinelData';
import { ToastProvider } from '../components/Toast';
import { OverviewPage } from '../features/dashboard/OverviewPage';
import { DigitalTwinPage } from '../features/digital-twin/DigitalTwinPage';
import { IncidentsPage } from '../features/incidents/IncidentsPage';
import { IncidentCommandPage } from '../features/war-room/IncidentCommandPage';
import { AiInvestigatorPage } from '../features/ai-investigator/AiInvestigatorPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { chronological, healthCounts, healthScore, layoutTwin, riskSummary } from '../lib/derive';

const conn = vi.hoisted(() => ({ isActive: true }));
vi.mock('spacetimedb/react', () => ({
  useSpacetimeDB: () => ({
    isActive: conn.isActive,
    identity: Identity.fromString(scenarioIdentityHex),
    connectionId: undefined,
    connectionError: conn.isActive ? undefined : new Error('WebSocket error'),
    getConnection: () => null,
  }),
  useTable: () => [[], true],
}));

beforeAll(() => {
  // jsdom lacks these; React Flow and Recharts probe them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  conn.isActive = true;
});

function renderAt(path: string, routePath: string, el: ReactNode, data: SentinelData = loadScenario()) {
  return render(
    <ToastProvider>
      <SentinelDataContext.Provider value={data}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePath} element={el} />
          </Routes>
        </MemoryRouter>
      </SentinelDataContext.Provider>
    </ToastProvider>
  );
}

const incidentOf = (d: SentinelData, scenario: string) => d.incidents.find(i => i.scenarioType === scenario)!;

describe('derived metrics from reducer-produced state', () => {
  const d = loadScenario();
  it('counts health across overlapping incidents and summarizes risk', () => {
    const c = healthCounts(d.assets);
    expect(c.total).toBe(16);
    expect(c.critical).toBe(3); // auth-svc, primary-db, ext-gateway (roots)
    expect(c.offline).toBe(4); // app-api, payment-svc, customer-portal, admin-portal
    expect(c.degraded).toBe(1); // analytics-svc (noncritical edge)
    expect(healthScore(d.assets)).toBeLessThan(60);
    expect(riskSummary(d.incidents, d.assets).level).toBe('severe');
  });

  it('lays out services deterministically, dependents left of requirements, independent of health', () => {
    const pos = layoutTwin(d.assets, d.dependencies);
    expect(pos.size).toBe(d.assets.length);
    expect(pos.get('customer-portal')!.x).toBeLessThan(pos.get('app-api')!.x);
    expect(pos.get('app-api')!.x).toBeLessThan(pos.get('primary-db')!.x);
    const healed = d.assets.map(a => ({ ...a, healthStatus: 'healthy', impactType: 'none' }));
    expect([...layoutTwin(healed, d.dependencies).entries()]).toEqual([...pos.entries()]);
    expect([...layoutTwin([...d.assets].reverse(), [...d.dependencies].reverse()).entries()].sort()).toEqual([...pos.entries()].sort());
  });

  it('orders each incident timeline cause before effect', () => {
    const db = incidentOf(d, 'database_outage');
    const ev = chronological(d.events.filter(e => e.incidentId === db.incidentId));
    const root = ev.findIndex(e => e.eventType === 'asset_failure_detected');
    const cascade = ev.findIndex(e => e.eventType === 'asset_marked_offline');
    expect(ev[0]?.eventType).toBe('incident_created');
    expect(root).toBeGreaterThan(-1);
    expect(root).toBeLessThan(cascade);
  });
});

describe('pages render with live-shaped data', () => {
  it('Overview shows risk, counts, recent incidents and synthetic telemetry', () => {
    renderAt('/', '/', <OverviewPage />);
    expect(screen.getByRole('heading', { name: 'Operations overview' })).toBeInTheDocument();
    expect(within(screen.getByRole('status', { name: 'System risk summary' })).getByText('Severe')).toBeInTheDocument();
    expect(screen.getByText('Monitored services').nextSibling).toHaveTextContent('16');
    expect(screen.getByText('Active incidents').nextSibling).toHaveTextContent('3');
    expect(screen.getAllByText(/Simulated traffic surge/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Generated by the built-in simulation engine/)).toBeInTheDocument();
  });

  it('Digital twin: search, filters and the asset inspector', () => {
    renderAt('/twin', '/twin', <DigitalTwinPage />);
    expect(screen.getByRole('heading', { name: 'Digital twin' })).toBeInTheDocument();
    const list = () => screen.getByRole('list', { name: 'Services' });
    expect(within(list()).getAllByRole('button')).toHaveLength(16);
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: 'pay' } });
    expect(within(list()).getAllByRole('button').map(b => b.textContent)).toEqual(['Payment Serviceoffline']);
    fireEvent.change(screen.getByPlaceholderText(/Search services/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Critical' }));
    expect(within(list()).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(within(list()).getByRole('button', { name: /Primary Database/ }));
    const panel = screen.getByRole('complementary', { name: 'Details for Primary Database' });
    expect(within(panel).getByText('primary-db', { selector: 'span' })).toBeInTheDocument();
    const telemetry = within(panel).getByLabelText('Telemetry');
    for (const m of ['CPU', 'Memory', 'Requests', 'Error rate', 'Latency', 'Connections']) expect(within(telemetry).getByText(m)).toBeInTheDocument();
    expect(within(panel).getByLabelText('Response controls for Primary Database')).toBeInTheDocument();
    expect(within(panel).getByText(/Outgoing — requires/)).toBeInTheDocument();
    expect(within(panel).getByText(/Incoming — required by \(4\)/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Details for Primary Database' })).toBeNull();
  });

  it('Digital twin blast-radius overlay for one incident', () => {
    const d = loadScenario();
    renderAt('/twin', '/twin', <DigitalTwinPage />, d);
    fireEvent.change(screen.getByLabelText('Blast radius'), { target: { value: String(incidentOf(d, 'database_outage').incidentId) } });
    expect(screen.getByText(/Blast radius · INC-/)).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Blast radius summary' })).getByText('Affected').nextSibling).toHaveTextContent('7');
  });

  it('Incidents: search, detail with blast radius, evidence and response controls', () => {
    const d = loadScenario();
    const db = incidentOf(d, 'database_outage');
    renderAt(`/incidents/${db.incidentId}`, '/incidents/:incidentId', <IncidentsPage />, d);
    expect(screen.getByRole('heading', { name: /Primary \(user\) Database unavailable/ })).toBeInTheDocument();
    const stats = within(screen.getByRole('group', { name: 'Blast radius summary' }));
    expect(stats.getByText('Affected').nextSibling).toHaveTextContent('7');
    expect(stats.getByText('Direct').nextSibling).toHaveTextContent('4');
    expect(stats.getByText('Indirect').nextSibling).toHaveTextContent('2');
    expect(stats.getByText('Max depth').nextSibling).toHaveTextContent('2');
    expect(screen.getAllByLabelText(/Dependency path to/).length).toBeGreaterThan(0);
    expect(within(screen.getByRole('list', { name: 'Synthetic evidence' })).getByText('Primary heartbeat lost')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request recovery/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Incident timeline')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Title or INC-id'), { target: { value: 'surge' } });
    expect(screen.getByText('Incident list (1)')).toBeInTheDocument();
  });

  it('Incidents: a contained compromise shows the pending two-person recovery', () => {
    const d = loadScenario();
    const a = incidentOf(d, 'auth_compromise');
    renderAt(`/incidents/${a.incidentId}`, '/incidents/:incidentId', <IncidentsPage />, d);
    const ctl = screen.getByLabelText('Response controls for Authentication Service');
    expect(within(ctl).getByText(/requested by Ben \(Analyst\)/)).toBeInTheDocument();
    expect(within(ctl).getByRole('link', { name: 'approve in Incident Command' })).toBeInTheDocument();
    expect(within(ctl).getByText(/Compromise: Contained/)).toBeInTheDocument();
  });

  it('Incident command', () => {
    const d = loadScenario();
    const db = incidentOf(d, 'database_outage');
    renderAt(`/command/${db.incidentId}`, '/command/:incidentId', <IncidentCommandPage />, d);
    expect(screen.getByText('Fail over to standby replica')).toBeInTheDocument();
    expect(screen.getByText('Freeze deploys during database recovery')).toBeInTheDocument();
    expect(screen.getByText('Primary heartbeat lost; standby lagging.')).toBeInTheDocument();
    expect(screen.getByText(/not end-to-end encrypted/)).toBeInTheDocument();
  });

  it('Incident command: second commander can approve the pending recovery', () => {
    const d = loadScenario();
    const a = incidentOf(d, 'auth_compromise');
    renderAt(`/command/${a.incidentId}`, '/command/:incidentId', <IncidentCommandPage />, d);
    expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
  });

  it('AI investigator shows agent status, tool trace, findings and approvable recommendations', () => {
    renderAt('/ai/1', '/ai/:investigationId', <AiInvestigatorPage />);
    expect(screen.getByText(/Nemotron Investigator online/)).toBeInTheDocument();
    expect(screen.getByText('test-fixture-model')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Agent tool calls')).getByText('simulate_recovery')).toBeInTheDocument();
    expect(screen.getByText('Fixture finding: primary-db is the root cause')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept → file recovery request/ })).toBeInTheDocument();
    expect(screen.getByText(/AI-generated, verify before acting/)).toBeInTheDocument();
  });

  it('AI investigator is honest when no agent is connected', () => {
    renderAt('/ai', '/ai', <AiInvestigatorPage />, { ...loadScenario(), services: [], aiInvestigations: [], aiFindings: [], aiSteps: [] });
    expect(screen.getByText('NVIDIA Nemotron agent not connected.')).toBeInTheDocument();
    expect(screen.getByText('No investigations')).toBeInTheDocument();
  });

  it('Settings shows the simulation engine, services and audit log', () => {
    renderAt('/settings', '/settings', <SettingsPage />);
    expect(screen.getByText('Audit log (latest 50)')).toBeInTheDocument();
    expect(screen.getAllByText('launch_simulated_incident').length).toBeGreaterThan(0);
    expect(screen.getByText(/tick #\d+ · every 3s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause synthetic telemetry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Initialize / sync demo environment' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('Scenario launcher lists four scenarios, previews impact and blocks duplicates', () => {
    renderAt('/', '/', <OverviewPage />);
    fireEvent.click(screen.getByRole('button', { name: /Launch Simulated Incident/ }));
    const dialog = screen.getByRole('dialog', { name: 'Launch a synthetic incident scenario' });
    expect(within(dialog).getAllByRole('radio')).toHaveLength(4);
    // Auth compromise is already active in the fixture → launch disabled.
    expect(within(dialog).getByRole('button', { name: 'Start simulation' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Ransomware-like file service incident/ }));
    expect(within(dialog).getByText(/Expected impact:/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Preview only/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Start simulation' })).toBeEnabled();
  });
});

describe('empty, loading and connection states', () => {
  it('no infrastructure', () => {
    const empty = { ...loadScenario(), assets: [], incidents: [], events: [], incidentAssets: [], dependencies: [], assetById: new Map() };
    renderAt('/', '/', <OverviewPage />, empty);
    expect(screen.getByText('No virtual infrastructure is loaded. Initialize the demo environment.')).toBeInTheDocument();
  });

  it('no incidents', () => {
    renderAt('/incidents', '/incidents', <IncidentsPage />, { ...loadScenario(), incidents: [] });
    expect(screen.getByText('No active incidents. Launch a synthetic scenario to test the environment.')).toBeInTheDocument();
  });

  it('loading skeleton while subscriptions apply', () => {
    renderAt('/incidents', '/incidents', <IncidentsPage />, { ...loadScenario(), ready: false });
    expect(screen.getByLabelText('Loading data from SpacetimeDB')).toBeInTheDocument();
  });

  it('disconnected: explicit message and retry instead of an endless skeleton', () => {
    conn.isActive = false;
    renderAt('/twin', '/twin', <DigitalTwinPage />, { ...loadScenario(), ready: false });
    expect(screen.getByText('Connection to SpacetimeDB lost. Live actions are unavailable until reconnection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeInTheDocument();
  });

  it('disconnected: state-changing actions are disabled with a reason', () => {
    conn.isActive = false;
    renderAt('/', '/', <OverviewPage />);
    expect(screen.getByRole('button', { name: /Launch Simulated Incident/ })).toBeDisabled();
    expect(screen.getByText('Disconnected from SpacetimeDB — actions unavailable')).toBeInTheDocument();
  });
});

// Physical sensor (real hardware)
describe('physical sensor card and real incidents', () => {
  const t = (s: number) => new Timestamp(1_700_000_000_000_000n + BigInt(s) * 1_000_000n);
  const node = (status = 'online') => ({ nodeId: 'uno-r4-01', assetId: 'env-uno-r4-01', name: 'Server closet', sensorModel: 'DHT11', tempLimitC: 30, humidityLimitPct: 70, status, lastReadingAt: t(40), breachStreak: 0, calmStreak: 0, activeIncidentId: undefined, silentIncidentId: undefined, registeredAt: t(0) });
  const readings = (temps: number[]) => temps.map((tempC, i) => ({ readingId: BigInt(i + 1), nodeId: 'uno-r4-01', tempC, humidityPct: 41, timestamp: t(i * 4) }));
  const withSensor = (temps: number[], status = 'online'): SentinelData => {
    const d = loadScenario();
    return { ...d, sensorNodes: [node(status)] as never, sensorReadings: readings(temps) as never, readingsByNode: new Map([['uno-r4-01', readings(temps)]]) as never };
  };

  it('shows live measured temperature and humidity, labelled as real', () => {
    renderAt('/', '/', <OverviewPage />, withSensor([23.4, 23.5, 23.6]));
    const card = screen.getByRole('list', { name: 'Physical sensor nodes' });
    expect(within(card).getByLabelText('Temperature')).toHaveTextContent('23.6');
    expect(within(card).getByLabelText('Humidity')).toHaveTextContent('41');
    expect(within(card).getByText('online')).toBeInTheDocument();
    expect(screen.getByText(/real measurements/)).toBeInTheDocument();
    expect(screen.getByText(/measured by real hardware, not simulated/)).toBeInTheDocument();
  });

  it('flags a silent node with a text label, not color alone', () => {
    renderAt('/', '/', <OverviewPage />, withSensor([23.5, 23.5], 'silent'));
    expect(within(screen.getByRole('list', { name: 'Physical sensor nodes' })).getByText('silent')).toBeInTheDocument();
  });

  it('renders no sensor card when no node is registered', () => {
    renderAt('/', '/', <OverviewPage />);
    expect(screen.queryByRole('list', { name: 'Physical sensor nodes' })).not.toBeInTheDocument();
  });

  it('marks a non-simulated incident as a real event, and simulations as simulations', () => {
    const d = loadScenario();
    const first = d.incidents[0]!;
    const data = { ...d, incidents: d.incidents.map(i => (i.incidentId === first.incidentId ? { ...i, isSimulation: false } : i)) } as SentinelData;
    renderAt('/', '/', <OverviewPage />, data);
    expect(screen.getAllByText('Real event')).toHaveLength(1);
    expect(screen.getAllByText('Simulation').length).toBeGreaterThan(0);
  });
});
