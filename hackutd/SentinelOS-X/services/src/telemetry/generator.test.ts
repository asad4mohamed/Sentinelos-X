import { describe, expect, it } from 'vitest';
import { generateBatch, generateSample, makeRng, type AssetView } from './generator';

const asset = (healthStatus: string, impactType = 'none', assetType = 'service'): AssetView => ({ assetId: 'app-api', assetType, healthStatus, impactType });

describe('synthetic telemetry generator', () => {
  it('is deterministic for a given seed', () => {
    const a = generateBatch([asset('healthy')], makeRng(42), 10);
    const b = generateBatch([asset('healthy')], makeRng(42), 10);
    expect(a).toEqual(b);
  });

  it('stays within the ranges the server validates', () => {
    const rng = makeRng(7);
    for (const h of ['healthy', 'degraded', 'critical', 'offline']) {
      for (let t = 0; t < 200; t++) {
        const s = generateSample(asset(h, h === 'critical' ? 'direct' : 'cascade'), rng, t);
        expect(s.latencyMs).toBeGreaterThanOrEqual(0);
        expect(s.errorRate).toBeGreaterThanOrEqual(0);
        expect(s.errorRate).toBeLessThanOrEqual(1);
        expect(s.cpuPct).toBeGreaterThanOrEqual(0);
        expect(s.cpuPct).toBeLessThanOrEqual(100);
        expect(Number.isFinite(s.throughputRpm)).toBe(true);
      }
    }
  });

  it('reflects health: degraded is slower and noisier, offline serves nothing', () => {
    const rng = makeRng(1);
    const avg = (h: string, f: (s: ReturnType<typeof generateSample>) => number) =>
      Array.from({ length: 100 }, (_, t) => f(generateSample(asset(h), rng, t))).reduce((x, y) => x + y) / 100;
    expect(avg('degraded', s => s.latencyMs)).toBeGreaterThan(avg('healthy', s => s.latencyMs) * 2);
    expect(avg('degraded', s => s.errorRate)).toBeGreaterThan(avg('healthy', s => s.errorRate));
    const off = generateSample(asset('offline', 'cascade'), rng, 0);
    expect(off).toMatchObject({ throughputRpm: 0, errorRate: 1 });
    expect(generateSample(asset('critical', 'direct', 'database'), rng, 0).cpuPct).toBeGreaterThan(90);
    expect(off.cpuPct).toBeLessThan(10);
  });

  it('never emits more than the 64-sample batch limit and one sample per asset', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...asset('healthy'), assetId: `a-${i}` }));
    const batch = generateBatch(many, makeRng(3), 0);
    expect(batch).toHaveLength(64);
    expect(new Set(batch.map(b => b.assetId)).size).toBe(64);
  });
});
