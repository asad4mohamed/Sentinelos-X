// Physical sensor nodes: REAL measurements from hardware, shown live from SpacetimeDB.
// Everything on this card is measured, never simulated.
import { Droplets, Radio, Thermometer } from 'lucide-react';
import { useSentinel } from '../../hooks/useSentinelData';
import { Panel } from '../../components/ui';
import { Sparkline } from '../../components/Sparkline';
import { relTime } from '../../lib/format';

const SHOWN = 60;

export function SensorPanel() {
  const { sensorNodes, readingsByNode } = useSentinel();
  if (sensorNodes.length === 0) return null;
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <Radio className="size-3.5" aria-hidden /> Physical sensors <span className="normal-case tracking-normal text-emerald-300">· real measurements</span>
        </span>
      }
    >
      <ul className="space-y-4" aria-label="Physical sensor nodes">
        {sensorNodes.map(n => {
          const readings = readingsByNode.get(n.nodeId) ?? [];
          const latest = readings[readings.length - 1];
          const recent = readings.slice(-SHOWN);
          const hot = latest !== undefined && latest.tempC >= n.tempLimitC;
          const humid = latest !== undefined && latest.humidityPct >= n.humidityLimitPct;
          const silent = n.status === 'silent';
          return (
            <li key={n.nodeId} className="grid gap-3 sm:grid-cols-[auto_1fr_1fr] sm:items-center">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  {n.name}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ${silent ? 'bg-red-500/10 text-red-300 ring-red-500/30' : 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'}`}>
                    {silent ? 'silent' : 'online'}
                  </span>
                </div>
                <div className="flex items-baseline gap-4 tabular-nums">
                  <span className={`inline-flex items-baseline gap-1 text-2xl font-semibold ${hot ? 'text-red-300' : 'text-slate-50'}`} aria-label="Temperature">
                    <Thermometer className="size-4 self-center text-slate-500" aria-hidden />
                    {latest ? latest.tempC.toFixed(1) : '—'}
                    <span className="text-sm font-normal text-slate-400">°C</span>
                  </span>
                  <span className={`inline-flex items-baseline gap-1 text-2xl font-semibold ${humid ? 'text-red-300' : 'text-slate-50'}`} aria-label="Humidity">
                    <Droplets className="size-4 self-center text-slate-500" aria-hidden />
                    {latest ? latest.humidityPct.toFixed(0) : '—'}
                    <span className="text-sm font-normal text-slate-400">%</span>
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">
                  limits {n.tempLimitC} °C / {n.humidityLimitPct}% · {n.sensorModel} · node {n.nodeId}
                </p>
              </div>
              <Sparkline label="Temperature" values={recent.map(r => r.tempC)} color={hot ? '#f87171' : '#22d3ee'} format={v => `${v.toFixed(1)} °C`} />
              <Sparkline label="Humidity" values={recent.map(r => r.humidityPct)} color={humid ? '#f87171' : '#34d399'} format={v => `${v.toFixed(0)}%`} />
              <p className="text-[11px] text-slate-500 sm:col-span-3">
                {readings.length} readings · last {n.lastReadingAt ? relTime(n.lastReadingAt) : 'never'} · measured by real hardware, not simulated. An excursion opens a real incident automatically.
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
