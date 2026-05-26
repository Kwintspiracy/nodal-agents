type Props = {
  points: number[];
  /** Stroke colour. Pass any CSS colour string — the SVG inherits via currentColor
   *  if you instead set `color` on a parent and pass `currentColor` here. */
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
};

/**
 * Sparkline — minimal smooth curve, no axes, no labels. Used inside the
 * VividStatCard for the small trend slot, and anywhere the design calls for
 * a 120×34 inline trend.
 *
 * Smoothing is a cheap two-point cubic per segment — looks identical to the
 * design bundle's `Spark` component at this size and ships in <40 lines.
 */
export default function Sparkline({
  points,
  color = 'currentColor',
  width = 120,
  height = 34,
  strokeWidth = 1.6,
  className,
}: Props) {
  if (points.length < 2) return null;
  const pad = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const xs = (i: number) => pad + ((width - 2 * pad) * i) / (points.length - 1);
  const ys = (v: number) => height - pad - ((v - min) / (max - min || 1)) * (height - 2 * pad);

  let d = `M ${xs(0)} ${ys(points[0]!)}`;
  for (let i = 1; i < points.length; i++) {
    const p0x = xs(i - 1);
    const p0y = ys(points[i - 1]!);
    const p1x = xs(i);
    const p1y = ys(points[i]!);
    const cx = (p0x + p1x) / 2;
    d += ` C ${cx} ${p0y}, ${cx} ${p1y}, ${p1x} ${p1y}`;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
      className={className}
    >
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}
