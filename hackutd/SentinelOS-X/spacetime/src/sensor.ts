// Physical environmental sensor node: pure, deterministic detection and evidence.
//
// Everything here works on REAL readings reported by an authorized hardware gateway
// (e.g. a DHT11 on an Arduino). There is no randomness and no simulation. If a value
// cannot be computed from the readings that exist, it is reported as 'unknown', never 0.
import type { EvidenceDraft } from './seed';

export interface Reading {
  tempC: number;
  humidityPct: number;
  /** Milliseconds since the Unix epoch, from the module clock at ingestion. */
  atMs: number;
}

export interface Limits {
  tempLimitC: number;
  humidityLimitPct: number;
}

export type BreachKind = 'temperature_high' | 'humidity_high' | 'temperature_rise';

export interface Breach {
  kind: BreachKind;
  value: number;
  limit: number;
}

/** Plausible physical range for any supported sensor; readings outside it are rejected as faulty. */
export const VALID_TEMP_C = { min: -40, max: 85 } as const;
export const VALID_HUMIDITY_PCT = { min: 0, max: 100 } as const;

/** Temperature rise (°C) above the minimum seen in the window that counts as a breach on its own. */
export const RISE_LIMIT_C = 3;
export const RISE_WINDOW_MS = 120_000;
/** Consecutive breaching readings required before an incident opens (debounce for sensor glitches). */
export const BREACH_STREAK_TO_OPEN = 2;
/** Consecutive calm readings required before readings are reported as normalized. */
export const CALM_STREAK_TO_CLEAR = 5;
/** Hysteresis: a reading is calm only when clearly inside the limits. */
export const CALM_MARGIN_TEMP_C = 1;
export const CALM_MARGIN_HUMIDITY_PCT = 5;

export function validateReading(tempC: number, humidityPct: number): string | null {
  if (!Number.isFinite(tempC) || tempC < VALID_TEMP_C.min || tempC > VALID_TEMP_C.max) {
    return `tempC out of range [${VALID_TEMP_C.min}, ${VALID_TEMP_C.max}]`;
  }
  if (!Number.isFinite(humidityPct) || humidityPct < VALID_HUMIDITY_PCT.min || humidityPct > VALID_HUMIDITY_PCT.max) {
    return `humidityPct out of range [${VALID_HUMIDITY_PCT.min}, ${VALID_HUMIDITY_PCT.max}]`;
  }
  return null;
}

export function validateLimits(l: Limits): string | null {
  if (!Number.isFinite(l.tempLimitC) || l.tempLimitC < 0 || l.tempLimitC > VALID_TEMP_C.max) return 'tempLimitC out of range';
  if (!Number.isFinite(l.humidityLimitPct) || l.humidityLimitPct <= 0 || l.humidityLimitPct > 100) return 'humidityLimitPct out of range';
  return null;
}

/** `history` is oldest to newest and includes the latest reading. */
export function detectBreaches(history: readonly Reading[], lim: Limits): Breach[] {
  const latest = history[history.length - 1];
  if (!latest) return [];
  const out: Breach[] = [];
  if (latest.tempC >= lim.tempLimitC) out.push({ kind: 'temperature_high', value: latest.tempC, limit: lim.tempLimitC });
  if (latest.humidityPct >= lim.humidityLimitPct) out.push({ kind: 'humidity_high', value: latest.humidityPct, limit: lim.humidityLimitPct });
  const windowed = history.slice(0, -1).filter(r => latest.atMs - r.atMs <= RISE_WINDOW_MS);
  if (windowed.length >= 2) {
    const rise = latest.tempC - Math.min(...windowed.map(r => r.tempC));
    if (rise >= RISE_LIMIT_C) out.push({ kind: 'temperature_rise', value: round1(rise), limit: RISE_LIMIT_C });
  }
  return out;
}

export function isCalm(r: Reading, lim: Limits): boolean {
  return r.tempC < lim.tempLimitC - CALM_MARGIN_TEMP_C && r.humidityPct < lim.humidityLimitPct - CALM_MARGIN_HUMIDITY_PCT;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Median temperature of readings older than the most recent `skipRecent`, or null when not computable. */
export function baselineTempC(history: readonly Reading[], skipRecent = 6): number | null {
  const older = history.slice(0, Math.max(0, history.length - skipRecent)).map(r => r.tempC).sort((a, b) => a - b);
  if (older.length < 3) return null;
  const mid = Math.floor(older.length / 2);
  return round1(older.length % 2 ? older[mid]! : (older[mid - 1]! + older[mid]!) / 2);
}

const LABEL: Record<BreachKind, string> = {
  temperature_high: 'Temperature above limit',
  humidity_high: 'Humidity above limit',
  temperature_rise: 'Rapid temperature rise',
};

export function severityOf(b: Breach): EvidenceDraft['severity'] {
  const over = b.value - b.limit;
  const step = b.kind === 'humidity_high' ? [10, 20] : b.kind === 'temperature_rise' ? [2, 5] : [3, 8];
  return over >= step[1]! ? 'critical' : over >= step[0]! ? 'high' : 'medium';
}

export function summarize(breaches: readonly Breach[]): string {
  return breaches
    .map(b => {
      if (b.kind === 'temperature_high') return `temperature ${b.value.toFixed(1)} °C (limit ${b.limit.toFixed(1)} °C)`;
      if (b.kind === 'humidity_high') return `humidity ${b.value.toFixed(0)}% (limit ${b.limit.toFixed(0)}%)`;
      return `temperature up ${b.value.toFixed(1)} °C within 2 min`;
    })
    .join(', ');
}

/** Evidence drafts built only from recorded readings. `synthetic` is false for these (set by the caller). */
export function buildEvidence(nodeId: string, sensorModel: string, breaches: readonly Breach[], history: readonly Reading[]): EvidenceDraft[] {
  const latest = history[history.length - 1]!;
  const base = baselineTempC(history);
  const windowS = history.length > 1 ? Math.round((latest.atMs - history[0]!.atMs) / 1000) : 0;
  const common = [
    { key: 'sensor', value: sensorModel },
    { key: 'node', value: nodeId },
    { key: 'temp_c', value: latest.tempC.toFixed(1) },
    { key: 'humidity_pct', value: latest.humidityPct.toFixed(0) },
    { key: 'baseline_c', value: base === null ? 'unknown' : base.toFixed(1) },
    { key: 'readings_in_window', value: String(history.length) },
    { key: 'window_s', value: String(windowS) },
  ];
  const drafts: EvidenceDraft[] = breaches.map(b => ({
    kind: 'environment',
    title: LABEL[b.kind],
    detail:
      b.kind === 'temperature_high'
        ? `Sensor ${nodeId} (${sensorModel}) measured ${b.value.toFixed(1)} °C, at or above the ${b.limit.toFixed(1)} °C limit, with ${latest.humidityPct.toFixed(0)}% humidity.`
        : b.kind === 'humidity_high'
          ? `Sensor ${nodeId} (${sensorModel}) measured ${b.value.toFixed(0)}% relative humidity, at or above the ${b.limit.toFixed(0)}% limit, at ${latest.tempC.toFixed(1)} °C.`
          : `Sensor ${nodeId} (${sensorModel}) temperature rose ${b.value.toFixed(1)} °C within ${RISE_WINDOW_MS / 1000} s (limit ${b.limit.toFixed(0)} °C), now ${latest.tempC.toFixed(1)} °C.`,
    severity: severityOf(b),
    indicators: [{ key: 'breach', value: b.kind }, { key: 'value', value: b.value.toFixed(1) }, { key: 'limit', value: b.limit.toFixed(1) }, ...common],
  }));
  const recent = history.slice(-8).map(r => `${Math.round((r.atMs - latest.atMs) / 1000)}s ${r.tempC.toFixed(1)}C/${r.humidityPct.toFixed(0)}%`);
  drafts.push({
    kind: 'environment',
    title: 'Most recent sensor readings',
    detail: `Last ${recent.length} readings (offset, temperature/humidity): ${recent.join('; ')}.`,
    severity: 'info',
    indicators: [{ key: 'sensor', value: sensorModel }, { key: 'node', value: nodeId }, { key: 'count', value: String(recent.length) }],
  });
  return drafts;
}
