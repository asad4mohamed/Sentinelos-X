import { memo } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';

export const Sparkline = memo(function Sparkline({
  values,
  color,
  label,
  format = v => v.toFixed(1),
  height = 44,
}: {
  values: number[];
  color: string;
  label: string;
  format?: (v: number) => string;
  height?: number;
}) {
  const data = values.map((v, i) => ({ i, v }));
  const last = values[values.length - 1];
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-500">{label}</span>
        <span className="font-mono text-slate-200 tabular-nums">{last === undefined ? '—' : format(last)}</span>
      </div>
      <div style={{ height }} role="img" aria-label={`${label} trend, latest ${last === undefined ? 'none' : format(last)}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip
              cursor={false}
              contentStyle={{ background: '#0a1220', border: '1px solid #1c2c44', fontSize: 11, padding: '2px 6px' }}
              formatter={v => [format(Number(v ?? 0)), label]}
              labelFormatter={() => ''}
            />
            <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});
