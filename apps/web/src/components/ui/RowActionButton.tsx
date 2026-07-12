import Link from 'next/link';
import type { ReactNode } from 'react';

type Tone = 'default' | 'danger';

type CommonProps = {
  tone?: Tone;
  disabled?: boolean;
  className?: string;
};

type SquareProps = CommonProps & {
  /** Icon-only square — the canonical row-action shape (audit UX-B5). `title`
   *  doubles as the tooltip and the `aria-label`, so it's mandatory here:
   *  there is no visible label to fall back on. */
  square: true;
  icon: ReactNode;
  title: string;
  children?: undefined;
  responsive?: undefined;
};

type LabeledProps = CommonProps & {
  square?: false;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  /** Icon-only below `sm:`, icon+label from `sm:` up. Only meaningful in the
   *  labeled (non-square) shape — square rows are already icon-only at every
   *  width. */
  responsive?: boolean;
};

type BaseProps = SquareProps | LabeledProps;

type Props =
  | (BaseProps & { href: string; onClick?: undefined; type?: undefined })
  | (BaseProps & { href?: undefined; onClick?: () => void; type?: 'button' | 'submit' });

const TONE_STYLES: Record<Tone, string> = {
  default: 'border-rule-2 text-ink-2 hover:bg-hover hover:text-ink',
  danger: 'border-err/30 text-err hover:border-err hover:bg-warn-bg',
};

// Square mode reads "light at rest, full at hover" for danger (spec: legible
// but not shouty sitting in a row of otherwise-neutral squares) — a fainter
// icon colour than the labeled shape's, which has a text label to carry the
// weight instead.
const SQUARE_TONE_STYLES: Record<Tone, string> = {
  default: 'border-rule-2 text-ink-2 hover:bg-hover hover:text-ink',
  danger: 'border-err/20 text-err/70 hover:border-err hover:bg-warn-bg hover:text-err',
};

/**
 * RowActionButton — the canonical per-row action control.
 *
 * Two shapes:
 *   - `square` (icon-only, `w-[30px] h-[30px]`) — the row-action grammar
 *     below. Used on every list/table row in the app.
 *   - labeled (icon+text, the original UX-B1 shape) — kept for controls that
 *     aren't a list row (e.g. an inline form's Cancel button). New list rows
 *     should NOT use this shape.
 *
 * ## The row-action grammar (audit UX-B5)
 *
 * One concept = one verb = one icon, everywhere. Order on a row is always
 * [object-specific actions] → Edit → Delete (Delete/Disconnect/Uninstall is
 * ALWAYS last). No kebab menus for these — every action square, always
 * visible, always in this order.
 *
 * | Concept                          | Tooltip                          | Icon (Phosphor)        |
 * |-----------------------------------|-----------------------------------|-------------------------|
 * | Edit (absorbs Customise, Rename,  | "Edit" or a short specific        | `PencilSimple`          |
 * | Configure, Edit config)           | variant ("Rename credential")     |                         |
 * | Delete / Disconnect / Uninstall   | "Delete" / "Disconnect" /         | `Trash` (Uninstall:     |
 * |                                    | "Uninstall"                       | `CloudX`)               |
 * | Assign                            | "Assign to agents"                | `UserPlus`              |
 * | Archive                           | "Archive"                          | `Archive`               |
 * | Restore                           | "Restore"                          | `ArrowCounterClockwise` |
 * | Run now                           | "Run now"                          | `Play` (weight="fill")  |
 * | Pause                             | "Pause"                            | `Pause` (weight="fill") |
 * | Enable                            | "Enable"                           | `PlayCircle` (weight=   |
 * |                                    |                                    | "fill") — NOT `Play`:   |
 * |                                    |                                    | a row can carry both    |
 * |                                    |                                    | Run-now and the pause/  |
 * |                                    |                                    | enable toggle, so the   |
 * |                                    |                                    | toggle's "on" icon must |
 * |                                    |                                    | read differently from   |
 * |                                    |                                    | Run now's plain triangle|
 * | Duplicate                         | "Duplicate"                        | `Copy`                  |
 * | Rotate (secret/key)                | "Rotate secret"                    | `ArrowsClockwise`       |
 * | Refresh                           | "Refresh"                          | `ArrowClockwise`        |
 * | Channels                          | "Channels"                         | `ChatsCircle`           |
 * | Revoke                            | "Revoke"                           | `Prohibit`              |
 *
 * (audit UX-B1: four incompatible geometries existed — SkillsAssignedTable
 * (h-[30px] rounded-[7px] border-rule), CredentialsTable (h-[28px]
 * rounded-md border-rule-2), WebhookRow (py-1 rounded-md border-rule-2),
 * AgentsList (rounded-lg border-rule-2, mobile icon/label swap). Geometry
 * settled on border-rule-2 + rounded-md at h-[30px] / text-[12px]. UX-B5
 * then unified the SHAPE — every list row now uses the square variant below,
 * no exceptions, no kebabs for standard row actions.)
 *
 * Renders a `<Link>` when `href` is given (Edit/Configure/Assign-style
 * navigation), a `<button>` otherwise (Delete/Archive/Refresh-style
 * in-place actions).
 */
export default function RowActionButton(props: Props) {
  const { tone = 'default', disabled, className = '' } = props;

  if (props.square) {
    const { icon, title } = props;
    const classes = `inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border bg-paper transition-colors disabled:opacity-40 ${SQUARE_TONE_STYLES[tone]} ${className}`;

    if ('href' in props && props.href) {
      return (
        <Link
          href={props.href}
          title={title}
          aria-label={title}
          aria-disabled={disabled || undefined}
          className={classes}
        >
          {icon}
        </Link>
      );
    }

    return (
      <button
        type={props.type ?? 'button'}
        onClick={props.onClick}
        disabled={disabled}
        title={title}
        aria-label={title}
        className={classes}
      >
        {icon}
      </button>
    );
  }

  const { icon, children, title, responsive = false } = props;
  const classes = `inline-flex h-[30px] items-center gap-1.5 rounded-md border bg-paper px-3 text-[12px] font-medium leading-none transition-colors disabled:opacity-40 ${TONE_STYLES[tone]} ${className}`;

  const iconEl = icon ? (
    <span className={responsive ? 'sm:hidden' : 'inline-flex shrink-0'}>{icon}</span>
  ) : null;
  const labelEl = <span className={responsive ? 'hidden sm:inline' : ''}>{children}</span>;

  if ('href' in props && props.href) {
    return (
      <Link
        href={props.href}
        title={title}
        aria-label={title}
        aria-disabled={disabled || undefined}
        className={classes}
      >
        {iconEl}
        {labelEl}
      </Link>
    );
  }

  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={classes}
    >
      {iconEl}
      {labelEl}
    </button>
  );
}
