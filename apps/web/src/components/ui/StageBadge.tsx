export type Stage = 'stable' | 'beta' | 'review';

const STYLE: Record<Stage, string> = {
  stable: 'bg-ok-bg text-ok',
  beta: 'bg-warn-bg text-warn',
  review: 'bg-run-bg text-run',
};

const LABEL: Record<Stage, string> = {
  stable: 'Stable',
  beta: 'Beta',
  review: 'Review',
};

/**
 * StageBadge — small uppercase pill for skill/connector maturity.
 * Maps to `.sklib-card .stage.*` in the design bundle.
 *
 * Sits absolute top-right of marketplace cards (caller positions). If a
 * `PRO` mark is also shown, that one renders to the LEFT of the stage
 * (per the design's `.pro + .stage` selector).
 */
export default function StageBadge({
  stage,
  className = '',
}: {
  stage: Stage;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-[5px] px-2.5 text-medium-12 leading-none! ${STYLE[stage]} ${className}`}
    >
      {LABEL[stage]}
    </span>
  );
}

/**
 * ProBadge — black mono "PRO" mark, paired with StageBadge on premium
 * marketplace items. Maps to `.sklib-card .pro`.
 */
export function ProBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex h-[22px] items-center rounded-[5px] bg-ink px-2.5 font-mono text-label-11 leading-none! tracking-[0.06em] text-canvas ${className}`}
    >
      PRO
    </span>
  );
}
