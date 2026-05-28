import type { ReactNode } from 'react';
import Disc from './Disc';

type DiscVariant = 'agent' | 'skill' | 'conn' | 'ink' | 'neutral';

type Props = {
  /** Coloured glyph in the upper-left. Either pass an icon child + variant
   *  to render via the canonical Disc, or pass `glyphBackground` for a
   *  brand-specific colour (Gmail red, Slack purple, …). */
  glyph: ReactNode;
  glyphVariant?: DiscVariant;
  glyphBackground?: string;

  /** Bold display name. */
  name: ReactNode;
  /** Body — usually a short tagline. */
  description?: ReactNode;
  /** Mono-uppercase category line under the description. */
  category?: ReactNode;

  /** Top-right area — typically a StageBadge + ProBadge or an InstalledBadge. */
  topRight?: ReactNode;

  /** Foot region — caller composes used-count text + a primary CTA + an
   *  optional secondary icon button (settings/menu). */
  foot?: ReactNode;

  className?: string;
};

/**
 * MarketplaceCard — paper card with a coloured glyph header, name +
 * description, category line, optional top-right badges, and a foot
 * slot for CTAs. Maps to `.mk2-card` / `.sklib-card` in the design
 * bundle (Connectors marketplace, Skills library).
 *
 * The card itself owns:
 *   - 14px rounded corners
 *   - paper bg + rule-2 border
 *   - 18px padding, 200px min-height
 *   - Disc-sized glyph at the top-left
 *   - foot pushed to the bottom via `mt-auto`
 *
 * Specialized callers (e.g. SkillLibraryCard) compose this primitive and
 * inject the right props rather than duplicating the geometry.
 */
export default function MarketplaceCard({
  glyph,
  glyphVariant = 'skill',
  glyphBackground,
  name,
  description,
  category,
  topRight,
  foot,
  className = '',
}: Props) {
  return (
    <div
      className={`relative flex h-full min-h-[200px] flex-col gap-1.5 rounded-2xl border border-rule-2 bg-paper p-[18px] ${className}`}
    >
      {topRight && (
        <div className="absolute top-3.5 right-3.5 flex items-center gap-1.5">{topRight}</div>
      )}

      <div className="mb-1.5">
        <Disc variant={glyphVariant} background={glyphBackground} size="lg" shape="square">
          {glyph}
        </Disc>
      </div>

      <div className="text-[15.5px] font-semibold leading-[1.2] tracking-[-0.005em] text-ink">
        {name}
      </div>
      {description && <div className="text-[13px] leading-[1.4] text-ink-3">{description}</div>}
      {category && (
        <div className="mt-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-4">
          {category}
        </div>
      )}

      {foot && (
        <div className="-mx-[18px] mt-auto flex items-center gap-2 border-t border-rule-2 px-[18px] pt-3.5">
          {foot}
        </div>
      )}
    </div>
  );
}
