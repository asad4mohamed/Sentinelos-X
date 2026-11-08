import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { ToastProvider } from '../components/Toast';
import { SentinelDataProvider } from '../hooks/useSentinelData';
import { OverviewPage } from '../features/dashboard/OverviewPage';
import { DigitalTwinPage } from '../features/digital-twin/DigitalTwinPage';
import { IncidentsPage } from '../features/incidents/IncidentsPage';
import { IncidentCommandPage } from '../features/war-room/IncidentCommandPage';
import { AiInvestigatorPage } from '../features/ai-investigator/AiInvestigatorPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { DecisionLabPage } from '../features/decision-lab/DecisionLabPage';
import { EmptyState } from '../components/ui';

export function App() {
  return (
    <ToastProvider>
      <SentinelDataProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<OverviewPage />} />
              <Route path="twin" element={<DigitalTwinPage />} />
              <Route path="incidents" element={<IncidentsPage />} />
              <Route path="incidents/:incidentId" element={<IncidentsPage />} />
              <Route path="command" element={<IncidentCommandPage />} />
              <Route path="command/:incidentId" element={<IncidentCommandPage />} />
              <Route path="ai" element={<AiInvestigatorPage />} />
              <Route path="ai/:investigationId" element={<AiInvestigatorPage />} />
              <Route path="lab" element={<DecisionLabPage />} />
              <Route path="lab/:incidentId" element={<DecisionLabPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<EmptyState title="Page not found" />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SentinelDataProvider>
    </ToastProvider>
  );
}
