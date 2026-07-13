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
 * (skip/back inline with a step's body copy). Never use it inside a
 * `<ModalFooter>`, and never for a primary or secondary action — the product
 * rule is "no text links to act"; this component is the one deliberate,
 * reviewed exception, not a door around PrimaryButton/RowActionButton.
 */
export default function TextButton({ className = '', type = 'button', ...rest }: Props) {
  return <button type={type} className={`transition-colors ${className}`} {...rest} />;
}
