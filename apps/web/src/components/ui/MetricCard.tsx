import type { ReactNode } from 'react';
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
  /** A small glyph before the label (the Sandbox perimeter cards, #876). */
  icon?: ReactNode;
  /**
   * `warn` colours the VALUE: a fact the reader should not take as the normal
   * state (the perimeter of a sandbox that is off). The label and the subtle
   * line keep their colours.
   */
  tone?: 'default' | 'warn';
  /** Extra content under the subtle line: the paths or ports a value covers. */
  children?: ReactNode;
  /** The card leads to the detail of its value, on the same page (`#…`) or not. */
  href?: string;
};

/**
 * MetricCard — one of the small white cards on the Home dashboard's
 * second row. The design fits six on a single row at 1440px, three at
 * mobile widths. Maps to `.h-metric` in the bundle. The Sandbox section uses
 * three of them for its perimeter (can write, cannot read, network).
 */
export default function MetricCard({
  label,
  value,
  unit,
  subtle,
  delta,
  icon,
  tone = 'default',
  children,
  href,
}: Props) {
  const upIsGood = delta?.upIsGood ?? true;
  const isPositive = delta && (delta.direction === 'up') === upIsGood;
  const deltaColour = !delta ? '' : isPositive ? 'text-ok' : 'text-err';
  const DeltaIcon = delta?.direction === 'down' ? ArrowDown : ArrowUp;

  const body = (
    <>
      <div className="flex items-center gap-1.5 truncate text-mono-11 uppercase tracking-[0.14em] text-ink-4">
        {icon}
        {label}
      </div>
      <div
        className={`mt-1 truncate text-numeral-22 leading-[1.1]! tracking-[-0.02em] ${tone === 'warn' ? 'text-warn' : 'text-ink'}`}
      >
        {value}
        {unit && <span className="ml-0.5 text-medium-12 text-ink-4">{unit}</span>}
      </div>
      {subtle && <div className="text-body-12 leading-[1.4]! text-ink-3">{subtle}</div>}
      {delta && (
        <div
          className={`mt-0.5 inline-flex items-center gap-1 text-mono-12 leading-none! tracking-[0.02em] ${deltaColour}`}
        >
          <DeltaIcon size={9} weight="bold" />
          {delta.text}
        </div>
      )}
      {children && <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">{children}</div>}
    </>
  );
  const frame = 'flex min-w-0 flex-col gap-1 rounded-xl border border-rule-2 bg-paper px-3.5 py-3';
  return href ? (
    <a href={href} className={`${frame} transition-colors hover:border-ink-4`}>
      {body}
    </a>
  ) : (
    <div className={frame}>{body}</div>
  );
}
