'use client';

// WeeklyActivityChart — 12-week rolling view of jobs, two decompositions at
// once on one shared count axis:
//
//   • Stacked bars  → jobs by STATUS (completed / awaiting / pending /
//     cancelled / failed). Kept as a dimmed background layer so they read as
//     context, not the headline.
//   • Lines         → jobs by the LLM MODEL the agent ran. One line per
//     distinct model seen in the window.
//
// Both add up to the same weekly total (Σ status == total jobs == Σ models),
// so the bars and the lines are two consistent cuts of the identical data —
// you can read "how much ran" and "which model ran it" in a single glance.
//
// The legend is custom so the two cuts read as two SEPARATE groups ("Status"
// vs "Models") rather than one undifferentiated row of swatches.
//
// Read-only: receives the pivot from `getWeeklyActivityAction` server-side
// (no client fetch). The /stats page can re-render at any time and the
// chart picks up the new data via prop change.

import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import PillTabs from '@/components/ui/PillTabs';
import type { WeeklyActivityRow, WeeklyActivityData } from '@/lib/actions.ts';

interface Props {
  /** 12-week rolling view. */
  weekly: WeeklyActivityData;
  /** 7-day rolling view (one column per day). */
  daily: WeeklyActivityData;
}

type Granularity = 'weekly' | 'daily';

// Status → color. Kept in a const so the legend + bars stay in sync.
// Hexes are read directly (recharts does not resolve CSS variables) but
// they MATCH the --c-* tokens — change one, change the other. The status
// bars sit BEHIND the model lines, so they're drawn with reduced opacity.
const STATUS_STYLE = {
  completed: { color: '#d4ff2e', label: 'Completed' }, // --c-agent-vivid
  awaiting: { color: '#3565ff', label: 'Awaiting' }, // --c-conn-vivid
  pending: { color: '#8aa8ff', label: 'Pending' }, // dimmer blue (in-flight, not yet picked up)
  cancelled: { color: '#9a9a9a', label: 'Cancelled' }, // --c-ink-4
  failed: { color: '#ff5631', label: 'Failed' }, // --c-skill-vivid
} as const;

type StatusKey = keyof typeof STATUS_STYLE;

// Palette for the model lines. Distinct, readable, and intentionally outside
// the status hues so a line is never confused with a bar segment. Cycles if
// there are more models than colours.
const MODEL_PALETTE = [
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#db2777', // pink
  '#ca8a04', // amber
  '#16a34a', // green
  '#e11d48', // rose
  '#475569', // slate
  '#9333ea', // purple
] as const;

// Tick formatter: collapse the ISO date to "MMM D" so the x-axis isn't
// overwhelmed by yyyy-mm-dd labels.
function formatWeekTick(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Minimal shape of the items recharts injects into a custom Legend.
interface LegendItem {
  value: string;
  type?: string;
  color?: string;
}

// Custom legend: split the flat payload from recharts into the two cuts and
// render each as its own labelled group. Bars come through as `type: 'rect'`,
// lines as `type: 'line'`.
function WeeklyLegend({ payload }: { payload?: LegendItem[] }) {
  const items = payload ?? [];
  const statusItems = items.filter((p) => p.type === 'rect');
  const modelItems = items.filter((p) => p.type !== 'rect');

  return (
    <div className="flex flex-col gap-2 px-1 pt-3 text-[12px] text-ink-3">
      {statusItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-4">
            Status
          </span>
          {statusItems.map((p) => (
            <span key={p.value} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-[3px]"
                style={{ background: p.color, opacity: 0.55 }}
              />
              {STATUS_STYLE[p.value as StatusKey]?.label ?? p.value}
            </span>
          ))}
        </div>
      )}
      {modelItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-4">
            Models
          </span>
          {modelItems.map((p) => (
            <span key={p.value} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-[2px] w-4 rounded-full"
                style={{ background: p.color }}
              />
              {p.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WeeklyActivityChart({ weekly, daily }: Props) {
  const [granularity, setGranularity] = useState<Granularity>('weekly');
  const active = granularity === 'weekly' ? weekly : daily;
  const data = active.rows;
  const models = active.models;

  const total = data.reduce(
    (acc, r) => acc + r.completed + r.awaiting + r.pending + r.cancelled + r.failed,
    0,
  );

  const emptyMessage =
    granularity === 'weekly' ? 'No jobs in the last 12 weeks.' : 'No jobs in the last 7 days.';
  // Daily ticks are already a single day; weekly ones mark the week's start.
  const labelPrefix = granularity === 'weekly' ? 'Week of ' : '';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-4">Activity</h2>
        <PillTabs<Granularity>
          tabs={[
            { value: 'weekly', label: 'Weekly' },
            { value: 'daily', label: 'Daily · 7d' },
          ]}
          value={granularity}
          onChange={setGranularity}
          variant="inset"
        />
      </div>
      <div className="rounded-2xl border border-rule-2 bg-paper px-3 py-4">
        {total === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-ink-3">
            {emptyMessage}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="var(--c-rule-2)" vertical={false} />
              <XAxis
                dataKey="week"
                tickFormatter={formatWeekTick}
                stroke="var(--c-ink-4)"
                tick={{ fill: 'var(--c-ink-4)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                stroke="var(--c-ink-4)"
                tick={{ fill: 'var(--c-ink-4)', fontSize: 12 }}
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
                  fontSize: 13,
                  color: 'var(--c-ink)',
                  boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
                }}
                labelStyle={{ color: 'var(--c-ink-3)' }}
                labelFormatter={(v) => `${labelPrefix}${formatWeekTick(String(v ?? ''))}`}
              />
              {/* left:0 cancels the chart's negative left margin, which would
                  otherwise drag the legend off the card's left edge. */}
              <Legend content={<WeeklyLegend />} wrapperStyle={{ left: 0, width: '100%' }} />
              {/* Status bars — background context, dimmed. */}
              {(Object.keys(STATUS_STYLE) as StatusKey[]).map((k) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="status"
                  fill={STATUS_STYLE[k].color}
                  fillOpacity={0.32}
                />
              ))}
              {/* Model lines — foreground, one per distinct LLM. */}
              {models.map((m, i) => (
                <Line
                  key={m}
                  type="monotone"
                  name={m}
                  dataKey={(row: WeeklyActivityRow) => row.models[m] ?? 0}
                  stroke={MODEL_PALETTE[i % MODEL_PALETTE.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
