'use client';

// WeeklyActivityChart — 12-week rolling stacked bar of jobs by status.
//
// Restyled to the new design system: paper card, design-token strokes,
// and recoloured bars that respect the strict 3-colour identity
// (lime/coral/blue) plus neutral ink for the cancelled bucket. The
// recharts bar shape stays — bars are still the clearest read for
// stacked status comparison across weeks.
//
// Read-only: receives the pivot from `getWeeklyActivityAction` server-side
// (no client fetch). The /stats page can re-render at any time and the
// chart picks up the new data via prop change.

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
// Hexes are read directly (recharts doesn't resolve CSS variables) but
// they MATCH the --c-* tokens — change one, change the other.
const STATUS_STYLE = {
  completed: { color: '#d4ff2e', label: 'Completed' }, // --c-agent-vivid
  awaiting: { color: '#3565ff', label: 'Awaiting' }, // --c-conn-vivid
  pending: { color: '#8aa8ff', label: 'Pending' }, // dimmer blue (in-flight, not yet picked up)
  cancelled: { color: '#9a9a9a', label: 'Cancelled' }, // --c-ink-4
  failed: { color: '#ff5631', label: 'Failed' }, // --c-skill-vivid
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
      <h2 className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-4">
        Weekly activity
      </h2>
      <div className="rounded-2xl border border-rule-2 bg-paper px-3 py-4">
        {total === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-ink-3">
            No jobs in the last 12 weeks.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="var(--c-rule-2)" vertical={false} />
              <XAxis
                dataKey="week"
                tickFormatter={formatWeekTick}
                stroke="var(--c-ink-4)"
                tick={{ fill: 'var(--c-ink-4)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                stroke="var(--c-ink-4)"
                tick={{ fill: 'var(--c-ink-4)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--c-hover)' }}
                contentStyle={{
                  background: 'var(--c-paper)',
                  border: '1px solid var(--c-rule)',
                  borderRadius: 10,
                  fontSize: 12,
                  color: 'var(--c-ink)',
                  boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
                }}
                labelStyle={{ color: 'var(--c-ink-3)' }}
                labelFormatter={(v) => `Week of ${formatWeekTick(String(v ?? ''))}`}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8, color: 'var(--c-ink-3)' }}
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
