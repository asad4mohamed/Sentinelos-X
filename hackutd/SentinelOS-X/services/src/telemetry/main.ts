// SentinelOS X software telemetry generator.
// Replaces the former hardware (Raspberry Pi / ESP32) telemetry plan with a
// software service. Produces SYNTHETIC metrics only.
import { env, loadEnv, log, startService } from '../shared/service';
import { tables } from '../module_bindings/index';
import { generateBatch, makeRng } from './generator';

loadEnv();
const intervalMs = Math.max(1000, Number(env('TELEMETRY_INTERVAL_MS', '2000')) || 2000);
const rng = makeRng(Date.now() & 0xffffffff);
const started = Date.now();

startService({
  slug: 'telemetry',
  name: 'Synthetic Telemetry Generator',
  kind: 'telemetry',
  subscribe: [tables.asset],
  onReady: ({ conn, authState }) => {
    let inFlight = false;
    let lastError = '';
    let sent = 0;
    setInterval(() => {
      if (inFlight || authState() !== 'authorized' || !conn.isActive) return;
      const assets = [...conn.db.asset.iter()];
      if (assets.length === 0) return;
      const samples = generateBatch(assets, rng, (Date.now() - started) / 1000);
      inFlight = true;
      conn.reducers
        .ingestTelemetry({ samples })
        .then(() => {
          sent++;
          lastError = '';
          if (sent === 1 || sent % 30 === 0) log('telemetry', `Published ${sent} batches (${samples.length} assets each)`);
        })
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== lastError) log('telemetry', 'Ingest rejected:', msg);
          lastError = msg;
        })
        .finally(() => (inFlight = false));
    }, intervalMs);
    log('telemetry', `Generating synthetic telemetry every ${intervalMs} ms once authorized.`);
  },
});
