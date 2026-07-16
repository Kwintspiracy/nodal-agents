import type { ReactNode } from 'react';
import { Plus } from '@phosphor-icons/react';
import PrimaryButton from './PrimaryButton';

type Props = {
  /** Optional left-aligned status line (e.g. "Used by 2 agents"). Omit to just
   *  push the CTA to the right — the installed count belongs in the card's
   *  top-right badge, not here. */
  status?: ReactNode;
  /** CTA label, e.g. "Install" / "Add account" / "Assign". The Plus icon is
   *  always prefixed — never put a literal "+" in the label. */
  ctaLabel: string;
  /** Accent: connectors + MCP use "blue", skills use "coral". */
  ctaVariant?: 'blue' | 'coral' | 'ink';
  /** Button-flavour handler. Mutually exclusive with `ctaHref`. */
  onCta?: () => void;
  /** Link-flavour destination. Mutually exclusive with `onCta`. */
  ctaHref?: string;
  /** Optional secondary action rendered just left of the primary CTA
   *  (e.g. a "Customise" link on built-in skill cards). */
  secondary?: ReactNode;
  /** Leading icon on the CTA. Defaults to a Plus; pass e.g. a download glyph
   *  for "Download" CTAs where a "+" would read wrong. */
  icon?: ReactNode;
};

/**
 * MarketplaceCardActions — the single shared footer-CTA row used by EVERY
 * marketplace card (connectors, MCP, skills). Centralising the Plus-icon +
 * label + accent here is deliberate: it's the one place the CTA is composed,
 * so the three marketplaces can no longer drift (the cause of a wrong-colour /
 * double-"+" bug existing in one grid but not another). Pass it into
 * `<MarketplaceCard foot={...} />`.
 */
export default function MarketplaceCardActions({
  status,
  ctaLabel,
  ctaVariant = 'blue',
  onCta,
  ctaHref,
  secondary,
  icon,
}: Props) {
  const lead = icon ?? <Plus size={12} weight="bold" />;
  return (
    <>
      {/* pas de leading-none avec truncate : overflow:hidden clipperait les
          descendantes ; la line-height de la ramp body-13 contient les glyphes */}
      <span className="min-w-0 flex-1 truncate text-body-13 whitespace-nowrap text-ink-3">
        {status}
      </span>
      {secondary}
      {ctaHref ? (
        <PrimaryButton variant={ctaVariant} size="sm" href={ctaHref} className="shrink-0">
          {lead}
          {ctaLabel}
        </PrimaryButton>
      ) : (
        <PrimaryButton variant={ctaVariant} size="sm" onClick={onCta} className="shrink-0">
          {lead}
          {ctaLabel}
        </PrimaryButton>
      )}
    </>
  );
}
