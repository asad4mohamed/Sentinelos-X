// Synthetic telemetry model used by the built-in simulation engine.
// Pure: values depend only on the asset's current twin state, the effect acting
// on it (if it is a root), the tick number and the supplied PRNG. The module
// passes ctx.random, SpacetimeDB's deterministic per-transaction generator.
import type { EffectKind, EffectPhase, HealthState } from './propagation';

export interface MetricSample {
  cpuPct: number;
  memoryPct: number;
  requestRpm: number;
  errorRate: number;
  latencyMs: number;
  connections: number;
}

export interface MetricInput {
  assetId: string;
  assetType: string;
  health: HealthState;
  operationalStatus: string; // online | degraded | offline
  /** Strongest live effect on this asset when it is a root. */
  rootKind?: EffectKind;
  rootPhase?: EffectPhase;
  intensity?: number;
}

const BASE: Record<string, MetricSample> = {
  web_application: { cpuPct: 35, memoryPct: 48, requestRpm: 4200, errorRate: 0.004, latencyMs: 120, connections: 900 },
  network_edge: { cpuPct: 25, memoryPct: 30, requestRpm: 9000, errorRate: 0.002, latencyMs: 8, connections: 2400 },
  service: { cpuPct: 45, memoryPct: 55, requestRpm: 6000, errorRate: 0.004, latencyMs: 45, connections: 600 },
  identity: { cpuPct: 30, memoryPct: 42, requestRpm: 2500, errorRate: 0.006, latencyMs: 30, connections: 400 },
  database: { cpuPct: 55, memoryPct: 72, requestRpm: 12000, errorRate: 0.001, latencyMs: 6, connections: 180 },
  storage: { cpuPct: 20, memoryPct: 35, requestRpm: 1500, errorRate: 0.002, latencyMs: 15, connections: 120 },
  observability: { cpuPct: 30, memoryPct: 50, requestRpm: 800, errorRate: 0.002, latencyMs: 25, connections: 60 },
  ingestion: { cpuPct: 35, memoryPct: 40, requestRpm: 3000, errorRate: 0.003, latencyMs: 12, connections: 220 },
  log_pipeline: { cpuPct: 15, memoryPct: 28, requestRpm: 2000, errorRate: 0.002, latencyMs: 20, connections: 40 },
  backup: { cpuPct: 10, memoryPct: 25, requestRpm: 50, errorRate: 0.001, latencyMs: 60, connections: 8 },
  messaging: { cpuPct: 40, memoryPct: 60, requestRpm: 7000, errorRate: 0.001, latencyMs: 4, connections: 350 },
  analytics: { cpuPct: 50, memoryPct: 65, requestRpm: 300, errorRate: 0.003, latencyMs: 250, connections: 30 },
};
const DEFAULT: MetricSample = { cpuPct: 30, memoryPct: 40, requestRpm: 1000, errorRate: 0.003, latencyMs: 50, connections: 100 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function phaseOf(assetId: string) {
  let h = 0;
  for (const c of assetId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 628) / 100;
}

export function generateMetrics(m: MetricInput, rand: () => number, tick: number): MetricSample {
  const b = BASE[m.assetType] ?? DEFAULT;
  const wave = 1 + 0.1 * Math.sin(tick / 12 + phaseOf(m.assetId));
  const j = (spread: number) => 1 + (rand() * 2 - 1) * spread;
  let s: MetricSample = { cpuPct: b.cpuPct * wave * j(0.08), memoryPct: b.memoryPct * j(0.04), requestRpm: b.requestRpm * wave * j(0.06), errorRate: b.errorRate * j(0.5), latencyMs: b.latencyMs * wave * j(0.1), connections: b.connections * wave * j(0.08) };
  const k = clamp(m.intensity ?? 0, 0, 1);

  if (m.rootKind && m.rootPhase !== 'recovering') {
    const contained = m.rootPhase === 'contained';
    switch (m.rootKind) {
      case 'overload':
        s = contained
          ? { ...s, cpuPct: 65 * j(0.08), requestRpm: s.requestRpm * 3, latencyMs: s.latencyMs * 1.8, errorRate: 0.02 * j(0.3), connections: s.connections * 3 }
          : { cpuPct: 88 + 11 * k * rand(), memoryPct: 78 + 15 * k, requestRpm: s.requestRpm * (4 + 10 * k), latencyMs: s.latencyMs * (3 + 9 * k), errorRate: 0.05 + 0.2 * k * j(0.2), connections: s.connections * (5 + 10 * k) };
        break;
      case 'compromise':
        s = contained
          ? { ...s, requestRpm: s.requestRpm * 1.3, errorRate: 0.05 * j(0.3), latencyMs: s.latencyMs * 1.3 }
          : { ...s, cpuPct: 72 * j(0.1), requestRpm: s.requestRpm * 2.6, errorRate: 0.32 * j(0.15), latencyMs: s.latencyMs * 1.6, connections: s.connections * 3 };
        break;
      case 'integrity':
        s = contained
          ? { cpuPct: 2 + rand() * 2, memoryPct: s.memoryPct * 0.5, requestRpm: 0, errorRate: 1, latencyMs: 0, connections: 0 }
          : { cpuPct: 95 + rand() * 5, memoryPct: 86 * j(0.04), requestRpm: s.requestRpm * 0.6, errorRate: 0.12 * j(0.2), latencyMs: s.latencyMs * 4, connections: s.connections * 1.4 };
        break;
      case 'outage':
      case 'fault':
        if (m.operationalStatus === 'offline') s = { cpuPct: 0, memoryPct: 0, requestRpm: 0, errorRate: 1, latencyMs: 0, connections: 0 };
        else s = { ...s, latencyMs: s.latencyMs * 3, errorRate: 0.06 * j(0.3), requestRpm: s.requestRpm * 0.6 };
        break;
    }
  } else if (m.operationalStatus === 'offline') {
    s = { cpuPct: 1 + rand() * 3, memoryPct: s.memoryPct * 0.6, requestRpm: 0, errorRate: 1, latencyMs: 0, connections: 0 };
  } else if (m.health === 'recovering') {
    s = { ...s, cpuPct: s.cpuPct * 1.4, latencyMs: s.latencyMs * 1.6, errorRate: 0.01 + 0.02 * rand(), requestRpm: s.requestRpm * 0.7, connections: s.connections * 0.7 };
  } else if (m.operationalStatus === 'degraded') {
    s = { ...s, latencyMs: s.latencyMs * (3 + 2 * rand()), errorRate: 0.03 + 0.09 * rand(), requestRpm: s.requestRpm * (0.4 + 0.2 * rand()), cpuPct: s.cpuPct * 1.5 };
  }

  return {
    cpuPct: r(clamp(s.cpuPct, 0, 100), 1),
    memoryPct: r(clamp(s.memoryPct, 0, 100), 1),
    requestRpm: r(Math.max(0, s.requestRpm), 0),
    errorRate: r(clamp(s.errorRate, 0, 1), 4),
    latencyMs: r(Math.max(0, s.latencyMs), 1),
    connections: r(Math.max(0, s.connections), 0),
  };
}
