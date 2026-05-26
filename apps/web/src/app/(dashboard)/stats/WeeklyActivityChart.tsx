'use client';

// WeeklyActivityChart — 12-week rolling stacked bar of jobs by status.
//
// Read-only: receives the pivot from `getWeeklyActivityAction` server-side
// (no client fetch). The /stats page can re-render at any time and the
// chart picks up the new data via prop change.
//
// Colors mirror `StatusBadge` so the chart and the badges below feel like
// the same vocabulary:
//   - completed: emerald (success)
//   - awaiting: amber (in flight)
//   - pending: yellow (not picked up — sticks out so a stuck pending is
//     visible without reading the legend)
//   - cancelled: gray
//   - failed: red
//
// Why recharts: minimal API for the standard cases, SSR-safe when
// wrapped in `<ResponsiveContainer>` (the actual D3 work happens on
// mount, never at server-render).

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { WeeklyActivityRow } from '@/lib/actions.ts';

interface Props {
  data: WeeklyActivityRow[];
}

// Status → color. Kept in a const so the legend + bars stay in sync.
const STATUS_STYLE = {
  completed: { color: '#34d399', label: 'Completed' }, // emerald-400
  awaiting: { color: '#fbbf24', label: 'Awaiting' }, // amber-400
  pending: { color: '#facc15', label: 'Pending' }, // yellow-400
  cancelled: { color: '#9ca3af', label: 'Cancelled' }, // neutral-400
  failed: { color: '#f87171', label: 'Failed' }, // red-400
} as const;

type StatusKey = keyof typeof STATUS_STYLE;

// Tick formatter: collapse the ISO date to "MMM D" so the x-axis isn't
// overwhelmed by yyyy-mm-dd labels.
function formatWeekTick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function WeeklyActivityChart({ data }: Props) {
  const total = data.reduce(
    (acc, r) => acc + r.completed + r.awaiting + r.pending + r.cancelled + r.failed,
    0,
  );

  return (
    <div>
      <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
        Weekly activity
      </h2>
      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-3 py-4">
        {total === 0 ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-neutral-500">
            No jobs in the last 12 weeks.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#262626" vertical={false} />
              <XAxis
                dataKey="week"
                tickFormatter={formatWeekTick}
                stroke="#737373"
                tick={{ fill: '#737373', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                stroke="#737373"
                tick={{ fill: '#737373', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: '#27272a55' }}
                contentStyle={{
                  background: '#0a0a0a',
                  border: '1px solid #404040',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) => `Week of ${formatWeekTick(String(v ?? ''))}`}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                formatter={(value: string) => STATUS_STYLE[value as StatusKey]?.label ?? value}
              />
              {(Object.keys(STATUS_STYLE) as StatusKey[]).map((k) => (
                <Bar key={k} dataKey={k} stackId="status" fill={STATUS_STYLE[k].color} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
