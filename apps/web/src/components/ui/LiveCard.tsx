import LiveDot from './LiveDot';

type Props = {
  /** Number of agents currently running. Hides the card entirely when undefined. */
  runningAgents?: number;
  /** Cosmetic throughput line, e.g. "2.4k tasks/hr". Optional — falls back to a
   *  short generic message when not provided. */
  throughput?: string;
  /** Fill ratio for the bottom progress bar, 0..1. Defaults to 0.36 — matches
   *  the design bundle's static placeholder. Once telemetry plumbing exists
   *  we can drive this from real load (runs/sec normalized to plan ceiling). */
  fill?: number;
};

/**
 * LiveCard — paper-coloured tile pinned at the bottom of the sidebar, showing
 * fleet liveness at a glance. Maps to `.side-live` in the design bundle.
 *
 * Renders nothing when there's no live data — empty space is better than a
 * card that says "0 agents running" forever.
 */
export default function LiveCard({ runningAgents, throughput, fill = 0.36 }: Props) {
  if (runningAgents === undefined) return null;
  const pct = Math.max(0, Math.min(1, fill)) * 100;
  return (
    <div className="mx-3 mt-2.5 rounded-[10px] border border-rule-2 bg-paper px-3 pt-2.5 pb-3">
      <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase leading-none tracking-[0.14em] text-ink-3">
        <LiveDot variant="lime" />
        Live
      </div>
      <div className="mt-1.5 text-[13px] leading-[1.35] text-ink-2">
        <b className="font-semibold text-ink">{runningAgents} agents</b>
        {throughput ? ` running · ${throughput}` : ' running'}
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-[2px] bg-black/[0.06] dark:bg-white/[0.06]">
        <i className="block h-full bg-agent-vivid" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
