import type { ReactNode } from 'react';

type Props = {
  title: ReactNode;
  description: ReactNode;
  /** Short labels rendered as mono chips under the description — the "kit". */
  tags?: string[];
  /** A small mono badge next to the title (e.g. "already here"). */
  badge?: ReactNode;
  /** Renders dashed + dimmed: informational state, NOT a disabled control. */
  muted?: boolean;
  onClick: () => void;
  className?: string;
};

/**
 * RecipeTile — a choice card with a title, a one-line description and
 * optional chips, in a grid of choices that each trigger an action. Distinct
 * from `ChoiceTile` (icon + label only), `OptionRadio` (persisted radio
 * selection) and `SelectableTile` (square visual picker). First call site:
 * RecipePicker's "What should this agent do?" grid.
 *
 * `muted` is deliberately NOT `disabled`: a recipe whose agent already exists
 * is still a valid choice (a second developer is a normal thing to want) —
 * the styling only informs.
 */
export default function RecipeTile({
  title,
  description,
  tags = [],
  badge,
  muted = false,
  onClick,
  className = '',
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full text-left rounded-lg border bg-canvas px-3.5 py-3 transition-colors',
        'hover:border-ink focus-visible:outline-2 focus-visible:outline-conn-vivid',
        muted ? 'border-dashed border-rule-2 opacity-75' : 'border-rule-2',
        className,
      ].join(' ')}
    >
      <span className="flex items-center gap-2">
        <span className="text-medium-14 text-ink">{title}</span>
        {badge}
      </span>
      <span className="block text-body-13 text-ink-3 mt-0.5 leading-snug">{description}</span>
      {tags.length > 0 && (
        <span className="flex flex-wrap gap-1 mt-2">
          {tags.map((t) => (
            <span
              key={t}
              className="text-micro-10 rounded px-1.5 py-px bg-paper border border-rule-2 text-ink-2"
            >
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
