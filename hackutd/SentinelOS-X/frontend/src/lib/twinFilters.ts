// Search and filtering for the Digital Twin. Pure and unit-tested.
import type { Asset } from '../types/domain';

export const HEALTH_FILTERS = ['healthy', 'degraded', 'critical', 'offline', 'recovering', 'at_risk'] as const;
export type HealthFilter = (typeof HEALTH_FILTERS)[number];

export interface TwinFilter {
  query: string;
  health: ReadonlySet<HealthFilter>;
  assetType: string; // '' = any
}

export const EMPTY_FILTER: TwinFilter = { query: '', health: new Set(), assetType: '' };

export function matchesHealth(a: Pick<Asset, 'healthStatus' | 'impactType'>, health: ReadonlySet<HealthFilter>): boolean {
  if (health.size === 0) return true;
  if (health.has(a.healthStatus as HealthFilter)) return true;
  return health.has('at_risk') && a.impactType === 'exposed';
}

export function matchesQuery(a: Pick<Asset, 'name' | 'assetId' | 'assetType'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return a.name.toLowerCase().includes(q) || a.assetId.toLowerCase().includes(q) || a.assetType.replace(/_/g, ' ').toLowerCase().includes(q);
}

export function isFilterActive(f: TwinFilter): boolean {
  return f.query.trim() !== '' || f.health.size > 0 || f.assetType !== '';
}

/** Asset ids matching every active criterion, sorted by name for keyboard navigation. */
export function filterAssets(assets: readonly Asset[], f: TwinFilter): string[] {
  return assets
    .filter(a => matchesQuery(a, f.query) && matchesHealth(a, f.health) && (f.assetType === '' || a.assetType === f.assetType))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(a => a.assetId);
}

export function assetTypes(assets: readonly Asset[]): string[] {
  return [...new Set(assets.map(a => a.assetType))].sort();
}
