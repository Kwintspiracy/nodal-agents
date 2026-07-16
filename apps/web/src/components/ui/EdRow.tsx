import type { ReactNode } from 'react';

type Props = {
  /** Brand / type glyph (use the `Disc` primitive). */
  glyph?: ReactNode;
  /** Bold primary label — may include trailing chips/PN via composition. */
  name: ReactNode;
  /** Secondary line under the name — descriptions, scope tags, etc. */
  description?: ReactNode;
  /** Trailing mono-style metadata (part-number, latency, "last 4m"…). */
  meta?: ReactNode;
  /** Right-edge action cluster — typically `<IcBtn>` settings / remove. */
  actions?: ReactNode;
  /** Optional revealed-on-expand body rendered under the row, separated by
   *  a border-top + bg-canvas/40 pad (per the handoff's `.ed-row[expanded]`
   *  treatment used for per-op whitelisting). */
  expanded?: ReactNode;
  className?: string;
};

/**
 * EdRow — canonical `.ed-row` row used inside the Agent Composer
 * (`screen-composer-v2.jsx`) for Skills, Connectors, Knowledge and Runs
 * tabs. Always rendered as a flex row with optional glyph / name /
 * description / trailing meta / actions, plus an optional expanded body
 * for sub-grids (e.g. per-operation whitelist).
 *
 * Compose with `Disc` (variant + shape="square") for the glyph slot so
 * brand colours stay consistent with /connectors and /skills.
 */
export default function EdRow({
  glyph,
  name,
  description,
  meta,
  actions,
  expanded,
  className = '',
}: Props) {
  return (
    <div className={`overflow-hidden rounded-[10px] border border-rule-2 bg-paper ${className}`}>
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        {glyph && <div className="flex-shrink-0">{glyph}</div>}
        <div className="min-w-0 flex-1">
          <div className="text-medium-14 leading-[1.2]! text-ink">{name}</div>
          {description && (
            <div className="mt-0.5 truncate text-body-13 leading-[1.3]! text-ink-3">
              {description}
            </div>
          )}
        </div>
        {meta && (
          <div className="flex-shrink-0 text-mono-11 tracking-[0.04em] text-ink-4">{meta}</div>
        )}
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-rule-2 bg-canvas/40 px-4 py-3">{expanded}</div>
      )}
    </div>
  );
}

/**
 * IcBtn — the small icon button used at the right edge of an EdRow.
 * Matches `.ic-btn` in the handoff: 28×28, rounded, ghost-style with
 * subtle hover. Pass a child SVG sized 11–13px.
 */
export function IcBtn({
  onClick,
  title,
  children,
  ariaLabel,
}: {
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-rule text-ink-3 transition-colors hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  );
}
