import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { App } from './app/App';
import { createConnectionBuilder } from './services/spacetime';
import './styles/index.css';

function Root() {
  // Built once; the provider owns the connection and its automatic reconnects.
  const connectionBuilder = useMemo(() => createConnectionBuilder(), []);
  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
