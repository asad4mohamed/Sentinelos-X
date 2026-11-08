import type { Timestamp } from 'spacetimedb';

export function tsDate(ts: Timestamp | undefined | null): Date | null {
  return ts ? ts.toDate() : null;
}

export function fmtTime(ts: Timestamp | undefined | null): string {
  const d = tsDate(ts);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function fmtDateTime(ts: Timestamp | undefined | null): string {
  const d = tsDate(ts);
  return d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function relTime(ts: Timestamp | undefined | null, now = Date.now()): string {
  const d = tsDate(ts);
  if (!d) return '—';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function micros(ts: Timestamp): bigint {
  return ts.microsSinceUnixEpoch;
}

export function byTimeAsc<T>(get: (x: T) => Timestamp) {
  return (a: T, b: T) => {
    const x = get(a).microsSinceUnixEpoch;
    const y = get(b).microsSinceUnixEpoch;
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

export function byTimeDesc<T>(get: (x: T) => Timestamp) {
  const asc = byTimeAsc(get);
  return (a: T, b: T) => asc(b, a);
}

export function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function shortId(hex: string): string {
  return hex.slice(0, 8);
}
