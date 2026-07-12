import Link from 'next/link';
import type { ReactNode } from 'react';

type Tone = 'default' | 'danger';

type BaseProps = {
  /** Leading icon, already sized (e.g. `<Trash size={13} />`). Conventional
   *  action → icon mapping used across the app, kept here as documentation
   *  rather than enforced (callers pick the Phosphor icon):
   *    Delete → Trash · Configure → GearSix · Edit → PencilSimple ·
   *    Assign → Plus · Customise → PencilSimple · Channels → ChatsCircle ·
   *    Rename → PencilSimple · Refresh → ArrowClockwise */
  icon?: ReactNode;
  children: ReactNode;
  tone?: Tone;
  title?: string;
  /** Icon-only below `sm:`, icon+label from `sm:` up — AgentsList's pattern
   *  for rows with several actions on narrow screens. Off by default: most
   *  existing tables (Skills, Credentials) always show icon + label. */
  responsive?: boolean;
  disabled?: boolean;
  className?: string;
};

type Props =
  | (BaseProps & { href: string; onClick?: undefined; type?: undefined })
  | (BaseProps & { href?: undefined; onClick?: () => void; type?: 'button' | 'submit' });

const TONE_STYLES: Record<Tone, string> = {
  default: 'border-rule-2 text-ink-2 hover:bg-hover hover:text-ink',
  danger: 'border-err/30 text-err hover:border-err hover:bg-warn-bg',
};

/**
 * RowActionButton — the canonical per-row action control (audit UX-B1: four
 * incompatible geometries existed — SkillsAssignedTable (h-[30px]
 * rounded-[7px] border-rule), CredentialsTable (h-[28px] rounded-md
 * border-rule-2), WebhookRow (py-1 rounded-md border-rule-2), AgentsList
 * (rounded-lg border-rule-2, mobile icon/label swap). This settles on the
 * geometry the majority already agreed on — border-rule-2 (3 of 4 tables)
 * and rounded-md (2 of 4, and the closest rounding to the odd rounded-[7px]
 * out) — at a fixed h-[30px] and text-[12px], values every existing
 * convention already used or rounded to.
 *
 * Renders a `<Link>` when `href` is given (Edit/Configure/Assign-style
 * navigation), a `<button>` otherwise (Delete/Archive/Refresh-style
 * in-place actions).
 */
export default function RowActionButton(props: Props) {
  const {
    icon,
    children,
    tone = 'default',
    title,
    responsive = false,
    disabled,
    className = '',
  } = props;

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
