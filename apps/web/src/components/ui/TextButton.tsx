import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * TextButton — plain, chromeless text-only trigger (no border, no
 * background, no fixed padding) for tertiary actions inline with body copy:
 * "← Back", "Skip for now". Distinct from PrimaryButton/RowActionButton
 * (both always carry a border/background/fixed height) — this is
 * deliberately bare; sizing and colour come entirely from the caller's
 * `className`.
 *
 * GOVERNED, not a loophole: reserved strictly for light tertiary navigation
 * (skip/back inline with a step's body copy) and, since the passe-26 review
 * of PR #46, for the INLINE DISCLOSURE of a piece of body copy or of a status
 * segment — "Show more / Show less" under a clamped paragraph, the token and
 * cost segments of a status bar that open their panel. A disclosure trigger
 * MUST carry `aria-expanded` (and `aria-controls` when the panel has an id);
 * it never acts on data. Never use it inside a `<ModalFooter>`, and never for
 * a primary or secondary action — the product rule is "no text links to
 * act"; this component is the one deliberate, reviewed exception, not a door
 * around PrimaryButton/RowActionButton (which "Back to the conversation"
 * style secondary actions must use).
 */
export default function TextButton({ className = '', type = 'button', ...rest }: Props) {
  return <button type={type} className={`transition-colors ${className}`} {...rest} />;
}
