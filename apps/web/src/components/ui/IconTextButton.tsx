import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  /** Leading visual — an icon, an avatar preview, anything the caller sizes itself (`shrink-0` is applied for it). */
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Classes for the title line — default matches VersionBadge's density; override per call site. */
  titleClassName?: string;
  subtitleClassName?: string;
  className?: string;
};

/**
 * IconTextButton — full-width clickable row: a leading visual + a stacked
 * title/subtitle pair. Distinct from PrimaryButton/RowActionButton (both
 * fixed-height, single-line) — this shape is for content-rich triggers that
 * open a modal (VersionBadge's "Update available" sidebar nudge,
 * AvatarPicker's avatar-preview trigger — both promoted together, DS Phase
 * 2A, confirming this is a real recurring shape and not a one-off).
 *
 * Deliberately unopinionated about spacing/border/colour — the two call
 * sites above have genuinely different chrome, so all of that comes from
 * the caller via `className` (gap, rounding, border, background, padding).
 */
export default function IconTextButton({
  icon,
  title,
  subtitle,
  titleClassName = 'text-legacy-11-5 font-medium leading-tight! text-ink',
  subtitleClassName = 'font-mono text-legacy-10 leading-tight! text-ink-3',
  className = '',
  type = 'button',
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={`flex w-full items-center text-left transition-colors ${className}`}
      {...rest}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${titleClassName}`}>{title}</span>
        {subtitle && <span className={`block truncate ${subtitleClassName}`}>{subtitle}</span>}
      </span>
    </button>
  );
}
