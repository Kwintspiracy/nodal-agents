'use client';

import { useMemo, useState } from 'react';
import PillTabs from '@/components/ui/PillTabs';
import type { WeeklyActivityRow } from '@/lib/actions';

type Range = '4w' | '12w';

type Props = {
  weekly: WeeklyActivityRow[];
};

/**
 * HomeActivityChart — 12-week stacked-by-status area chart wearing the
 * design's three-colour palette: completed (lime) over awaiting/pending
 * (blue) over failed/cancelled (coral). Lets the user toggle a tighter
 * 4-week window without re-fetching.
 *
 * Why 12-week not 24-hour: the design's mock chart was hourly but our
 * actual telemetry rolls up weekly (12-week index lives in DB already).
 * We honour the design's *visual* — layered tinted areas, mono axis
 * labels, segmented range toggle — with truthful data behind it.
 */
export default function HomeActivityChart({ weekly }: Props) {
  const [range, setRange] = useState<Range>('12w');

  const data = useMemo(() => (range === '4w' ? weekly.slice(-4) : weekly), [range, weekly]);
  const total = useMemo(
    () =>
      data.reduce(
        (acc, r) => acc + r.completed + r.failed + r.cancelled + r.awaiting + r.pending,
        0,
      ),
    [data],
  );

  // Geometry — viewBox is cosmetic; the SVG resizes to its container.
  const W = 1100;
  const H = 240;
  const PAD = 28;
  const xs = (i: number) => PAD + ((W - 2 * PAD) * (i + 0.5)) / Math.max(1, data.length);
  const peak = Math.max(
    1,
    ...data.map((r) => r.completed + r.failed + r.cancelled + r.awaiting + r.pending),
  );
  const ys = (v: number) => H - PAD - (v / peak) * (H - 2 * PAD - 10);
  // Round the y-axis ticks so they land on nice numbers.
  const ticks = niceTicks(peak, 4);

  // Catmull-Rom -> cubic smoothing (same shape as the design's HomeScreen
  // bundle helper). Renders a clean curve through every point.
  const smooth = (pts: Array<[number, number]>) => {
    if (pts.length < 2) return '';
    let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  };

  // Stack: completed at the BASE (most reassuring), awaiting/pending in
  // the middle, failed/cancelled at the TOP (the things you most want
  // to notice when they grow).
  const seriesPoints = (kind: 'completed' | 'middle' | 'top') =>
    data.map((r, i) => {
      const completed = r.completed;
      const middle = completed + r.awaiting + r.pending;
      const top = middle + r.failed + r.cancelled;
      const v = kind === 'completed' ? completed : kind === 'middle' ? middle : top;
      return [xs(i), ys(v)] as [number, number];
    });

  const areaPath = (kind: 'completed' | 'middle' | 'top') => {
    const pts = seriesPoints(kind);
    if (pts.length === 0) return '';
    const top = smooth(pts);
    return `${top} L ${xs(data.length - 1)} ${H - PAD} L ${xs(0)} ${H - PAD} Z`;
  };

  const formatWeekShort = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="mt-[18px] rounded-2xl border border-rule-2 bg-paper px-4 pt-4 pb-3">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-4">
            Fleet activity
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 text-[30px] font-medium leading-[1.05] tracking-[-0.015em] text-ink">
            {total.toLocaleString()}
            <span className="text-[13px] leading-none text-ink-3">
              jobs · last {range === '4w' ? '4 weeks' : '12 weeks'}
            </span>
          </div>
        </div>
        <PillTabs
          value={range}
          onChange={(v) => setRange(v)}
          tabs={[
            { value: '4w', label: '4w' },
            { value: '12w', label: '12w' },
          ]}
        />
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hac-base" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--c-agent-vivid)" stopOpacity="0.45" />
            <stop offset="1" stopColor="var(--c-agent-vivid)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hac-mid" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--c-conn-vivid)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--c-conn-vivid)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hac-top" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--c-skill-vivid)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--c-skill-vivid)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y grid + tick labels */}
        {ticks.map((t) => {
          const y = ys(t);
          return (
            <g key={t}>
              <line
                x1={PAD}
                x2={W - PAD}
                y1={y}
                y2={y}
                stroke="var(--c-rule-2)"
                strokeDasharray="2 4"
              />
              <text
                x={PAD - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-ink-4 font-mono"
                style={{ fontSize: 9.5, letterSpacing: '0.04em' }}
              >
                {t}
              </text>
            </g>
          );
        })}

        {/* X labels — render every other week to keep the axis breathable */}
        {data.map((r, i) =>
          i % Math.ceil(data.length / 6) === 0 ? (
            <text
              key={r.week}
              x={xs(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-ink-4 font-mono"
              style={{ fontSize: 9.5, letterSpacing: '0.04em' }}
            >
              {formatWeekShort(r.week)}
            </text>
          ) : null,
        )}

        {/* Stacked areas — top first so lower layers paint over them */}
        <path d={areaPath('top')} fill="url(#hac-top)" />
        <path d={areaPath('middle')} fill="url(#hac-mid)" />
        <path d={areaPath('completed')} fill="url(#hac-base)" />

        {/* Stroke lines on top for clarity */}
        <path
          d={smooth(seriesPoints('completed'))}
          fill="none"
          stroke="var(--c-agent-vivid)"
          strokeWidth="1.6"
        />
        <path
          d={smooth(seriesPoints('middle'))}
          fill="none"
          stroke="var(--c-conn-vivid)"
          strokeWidth="1.4"
          opacity="0.8"
        />
        <path
          d={smooth(seriesPoints('top'))}
          fill="none"
          stroke="var(--c-skill-vivid)"
          strokeWidth="1.4"
          opacity="0.7"
        />
      </svg>

      <div className="mt-2 flex flex-wrap gap-4 text-[12px] leading-none text-ink-3">
        <span className="inline-flex items-center gap-2">
          <i className="inline-block h-2 w-2 rounded-full bg-agent-vivid" />
          Completed
        </span>
        <span className="inline-flex items-center gap-2">
          <i className="inline-block h-2 w-2 rounded-full bg-conn-vivid" />
          In flight
        </span>
        <span className="inline-flex items-center gap-2">
          <i className="inline-block h-2 w-2 rounded-full bg-skill-vivid" />
          Failed / cancelled
        </span>
      </div>
    </div>
  );
}

/** Pick 3-5 round numbers (1/2/5 × 10^n) spanning [0, peak]. */
function niceTicks(peak: number, count = 4): number[] {
  if (peak <= 0) return [0];
  const raw = peak / count;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const candidates = [1, 2, 5, 10].map((m) => m * base);
  const step = candidates.find((c) => c >= raw) ?? candidates[candidates.length - 1]!;
  const out: number[] = [];
  for (let v = 0; v <= peak + step / 2; v += step) out.push(Math.round(v));
  return out;
}
