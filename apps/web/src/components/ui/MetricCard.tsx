import { ArrowUp, ArrowDown } from '@phosphor-icons/react/dist/ssr';

type Delta = {
  /** Display string e.g. "+18.2% w/w". */
  text: string;
  direction: 'up' | 'down';
  /** Whether "up" is a good thing for this metric. Defaults to true.
   *  For metrics where lower is better (e.g. avg duration), pass false so the
   *  green/red colouring follows good/bad rather than direction. */
  upIsGood?: boolean;
};

type Props = {
  label: string;
  value: string;
  /** Tiny unit after the number, e.g. "%", "M". Styled smaller and muted. */
  unit?: string;
  /** Optional small line under the value (e.g. "completed jobs"). */
  subtle?: string;
  /** Optional w/w or m/m delta. Hidden when not provided — better than a "—". */
  delta?: Delta;
};

/**
 * MetricCard — one of the small white cards on the Home dashboard's
 * second row. The design fits six on a single row at 1440px, three at
 * mobile widths. Maps to `.h-metric` in the bundle.
 */
export default function MetricCard({ label, value, unit, subtle, delta }: Props) {
  const upIsGood = delta?.upIsGood ?? true;
  const isPositive = delta && (delta.direction === 'up') === upIsGood;
  const deltaColour = !delta ? '' : isPositive ? 'text-ok' : 'text-err';
  const DeltaIcon = delta?.direction === 'down' ? ArrowDown : ArrowUp;

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-rule-2 bg-paper px-3.5 py-3">
      <div className="truncate font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
        {label}
      </div>
      <div className="mt-1 truncate text-[22px] font-medium leading-[1.1] tracking-[-0.02em] text-ink">
        {value}
        {unit && <span className="ml-0.5 text-[11px] font-medium text-ink-4">{unit}</span>}
      </div>
      {subtle && <div className="text-[11px] leading-none text-ink-3">{subtle}</div>}
      {delta && (
        <div
          className={`mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] leading-none tracking-[0.02em] ${deltaColour}`}
        >
          <DeltaIcon size={9} weight="bold" />
          {delta.text}
        </div>
      )}
    </div>
  );
}
