// Synthetic software telemetry. Values are derived from the twin's current
// health so charts reflect what the deterministic propagation engine decided.
// This is simulation data and is labeled as such everywhere it is shown.

export interface AssetView {
  assetId: string;
  assetType: string;
  healthStatus: string; // healthy | degraded | critical | offline
  impactType: string; // none | direct | cascade
}

export interface TelemetryInput {
  assetId: string;
  latencyMs: number;
  errorRate: number;
  cpuPct: number;
  throughputRpm: number;
}

/** Small deterministic PRNG (mulberry32) so tests and replays are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASELINE: Record<string, { latency: number; cpu: number; rpm: number }> = {
  web_application: { latency: 120, cpu: 35, rpm: 4200 },
  network_edge: { latency: 8, cpu: 25, rpm: 9000 },
  service: { latency: 45, cpu: 45, rpm: 6000 },
  identity: { latency: 30, cpu: 30, rpm: 2500 },
  database: { latency: 6, cpu: 55, rpm: 12000 },
  storage: { latency: 15, cpu: 20, rpm: 1500 },
  observability: { latency: 25, cpu: 30, rpm: 800 },
  ingestion: { latency: 12, cpu: 35, rpm: 3000 },
  log_pipeline: { latency: 20, cpu: 15, rpm: 2000 },
  backup: { latency: 60, cpu: 10, rpm: 50 },
};
const DEFAULT = { latency: 50, cpu: 30, rpm: 1000 };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function phase(assetId: string): number {
  let h = 0;
  for (const c of assetId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 628) / 100;
}

export function generateSample(a: AssetView, rng: () => number, tSec: number): TelemetryInput {
  const b = BASELINE[a.assetType] ?? DEFAULT;
  const wave = 1 + 0.12 * Math.sin(tSec / 30 + phase(a.assetId)); // gentle diurnal-style drift
  const jitter = (spread: number) => 1 + (rng() * 2 - 1) * spread;

  if (a.healthStatus === 'healthy') {
    return {
      assetId: a.assetId,
      latencyMs: round(b.latency * wave * jitter(0.1)),
      errorRate: round(0.001 + rng() * 0.009, 4),
      cpuPct: round(clamp(b.cpu * wave * jitter(0.1), 1, 100), 1),
      throughputRpm: round(b.rpm * wave * jitter(0.08), 0),
    };
  }
  if (a.healthStatus === 'degraded') {
    return {
      assetId: a.assetId,
      latencyMs: round(b.latency * (3 + rng() * 2) * wave),
      errorRate: round(0.03 + rng() * 0.09, 4),
      cpuPct: round(clamp(b.cpu * 1.6 * jitter(0.15), 1, 100), 1),
      throughputRpm: round(b.rpm * (0.4 + rng() * 0.2), 0),
    };
  }
  // offline: no successful traffic. A directly compromised host shows saturated
  // CPU (modeled encryption activity); a host taken down by a dependency idles.
  const compromised = a.healthStatus === 'critical' || a.impactType === 'direct';
  return {
    assetId: a.assetId,
    latencyMs: 0,
    errorRate: 1,
    cpuPct: round(compromised ? clamp(94 + rng() * 6, 0, 100) : 1 + rng() * 3, 1),
    throughputRpm: 0,
  };
}

export function generateBatch(assets: readonly AssetView[], rng: () => number, tSec: number): TelemetryInput[] {
  return [...assets]
    .sort((x, y) => x.assetId.localeCompare(y.assetId))
    .slice(0, 64)
    .map(a => generateSample(a, rng, tSec));
}
