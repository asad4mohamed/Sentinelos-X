// Input validation shared by reducers. Every function throws SenderError with a
// message that is safe to show to the caller.
import { SenderError } from 'spacetimedb/server';

export const ROLES = ['incident_commander', 'security_analyst', 'legal_responder', 'observer'] as const;
export type Role = (typeof ROLES)[number];

export const INCIDENT_STATUSES = ['open', 'investigating', 'contained', 'recovering', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RECOVERY_STATUSES = ['pending', 'approved', 'rejected'] as const;

// Allowed incident status transitions. 'resolved' is terminal and only reachable
// through the resolve_incident reducer.
const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['investigating', 'contained'],
  investigating: ['contained', 'recovering'],
  contained: ['investigating', 'recovering'],
  recovering: ['investigating', 'contained'],
  resolved: [],
};

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['in_progress', 'blocked', 'done'],
  in_progress: ['todo', 'blocked', 'done'],
  blocked: ['todo', 'in_progress'],
  done: ['in_progress'],
};

export function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SenderError(`Invalid ${field} '${value}'. Expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

// Rejects control characters other than newline/tab; keeps Unicode text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function text(value: string, field: string, min: number, max: number): string {
  const v = value.trim();
  if (v.length < min) throw new SenderError(`${field} must be at least ${min} characters`);
  if (v.length > max) throw new SenderError(`${field} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(v)) throw new SenderError(`${field} contains control characters`);
  return v;
}

export function singleLine(value: string, field: string, min: number, max: number): string {
  const v = text(value, field, min, max);
  if (/[\r\n]/.test(v)) throw new SenderError(`${field} must be a single line`);
  return v;
}

const ASSET_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
export function assetId(value: string): string {
  if (!ASSET_ID.test(value)) throw new SenderError(`Invalid asset id '${value.slice(0, 60)}'`);
  return value;
}

export function incidentTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (to === 'resolved') throw new SenderError('Use resolve_incident to resolve an incident');
  if (!INCIDENT_TRANSITIONS[from].includes(to)) {
    throw new SenderError(`Invalid incident status transition ${from} -> ${to}`);
  }
}

export function taskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) throw new SenderError(`Task is already '${to}'`);
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new SenderError(`Invalid task status transition ${from} -> ${to}`);
  }
}

export interface MetaEntry {
  key: string;
  value: string;
}

/** Structured event metadata: bounded key/value pairs, never free-form blobs. */
export function metadata(entries: readonly MetaEntry[]): MetaEntry[] {
  if (entries.length > 16) throw new SenderError('At most 16 metadata entries are allowed');
  const seen = new Set<string>();
  return entries.map(e => {
    const key = singleLine(e.key, 'Metadata key', 1, 40);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new SenderError(`Invalid metadata key '${key}'`);
    if (seen.has(key)) throw new SenderError(`Duplicate metadata key '${key}'`);
    seen.add(key);
    return { key, value: text(e.value, 'Metadata value', 0, 200) };
  });
}
