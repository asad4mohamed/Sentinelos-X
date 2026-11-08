import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { BarChart3, Boxes, Cloud, Database, Eye, HardDrive, KeyRound, Network, RadioTower, Server, ShieldCheck, ScrollText, Workflow, type LucideIcon } from 'lucide-react';
import type { Asset } from '../../types/domain';
import { ExposureBadge, HEALTH_META, HealthBadge } from '../../components/StatusBadge';
import { humanize } from '../../lib/format';

const TYPE_ICON: Record<string, LucideIcon> = {
  web_application: Cloud,
  network_edge: Network,
  service: Server,
  identity: KeyRound,
  database: Database,
  storage: HardDrive,
  observability: Eye,
  ingestion: RadioTower,
  log_pipeline: ScrollText,
  backup: ShieldCheck,
  messaging: Workflow,
  analytics: BarChart3,
};

const CRIT: Record<string, { label: string; cls: string }> = {
  mission_critical: { label: 'Mission critical', cls: 'text-red-300' },
  high: { label: 'High', cls: 'text-amber-300' },
  medium: { label: 'Medium', cls: 'text-slate-300' },
  low: { label: 'Low', cls: 'text-slate-500' },
};

export type AssetNodeData = {
  asset: Asset;
  latencyMs?: number;
  incidentCount: number;
  dimmed: boolean;
  /** Role inside the blast-radius overlay, when one is shown. */
  overlay?: 'root' | 'direct' | 'indirect' | 'exposed';
};
export type AssetFlowNode = Node<AssetNodeData, 'asset'>;

export const AssetNode = memo(function AssetNode({ data, selected }: NodeProps<AssetFlowNode>) {
  const a = data.asset;
  const meta = HEALTH_META[a.healthStatus] ?? HEALTH_META.offline;
  const Icon = TYPE_ICON[a.assetType] ?? Boxes;
  const crit = CRIT[a.criticality] ?? CRIT.low;
  const border = a.impactType === 'exposed' ? '#a78bfa' : meta.hex;
  return (
    <div
      className={`w-56 rounded-lg border bg-ink-850 px-3 py-2.5 shadow-sm transition-[opacity,box-shadow] ${selected ? 'ring-2 ring-cyan-400' : ''} ${data.overlay === 'root' ? 'shadow-[0_0_0_3px_rgba(248,113,113,0.25)]' : ''}`}
      style={{ borderColor: border, borderStyle: a.impactType === 'cascade' || a.impactType === 'exposed' ? 'dashed' : 'solid', opacity: data.dimmed ? 0.3 : 1 }}
      aria-label={`${a.name}, ${a.healthStatus}${a.impactType === 'exposed' ? ', at risk' : ''}, ${a.operationalStatus}`}
    >
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-slate-500" />
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-slate-500" />
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" style={{ color: meta.hex }} aria-hidden />
        <span className="truncate text-sm font-semibold text-slate-100">{a.name}</span>
        {data.incidentCount > 0 && (
          <span className="ml-auto shrink-0 rounded bg-red-500/20 px-1 text-[10px] font-semibold text-red-200" title={`${data.incidentCount} active incident(s)`}>
            {data.incidentCount} INC
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <HealthBadge status={a.healthStatus} />
        {a.impactType === 'exposed' && <ExposureBadge />}
        <span className="ml-auto text-[10px] tracking-wide text-slate-500 uppercase">{a.operationalStatus === 'online' ? 'available' : a.operationalStatus}</span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
        <span>
          {humanize(a.assetType)}
          {data.latencyMs !== undefined && (
            <span className="ml-1.5 font-mono text-slate-400" title="Latest synthetic telemetry">
              {a.operationalStatus === 'offline' ? 'no response' : `${data.latencyMs.toFixed(0)}ms`}
            </span>
          )}
        </span>
        <span className={crit.cls}>{crit.label}</span>
      </div>
      {a.impactType !== 'none' && (
        <div className="mt-1 truncate text-[10px] font-medium" style={{ color: border }}>
          {a.impactType === 'direct' ? '● Root cause' : a.impactType === 'exposed' ? `◌ Exposed via ${a.impactCausedBy ?? '?'}` : `↳ Impacted via ${a.impactCausedBy ?? '?'}`}
        </div>
      )}
    </div>
  );
});
