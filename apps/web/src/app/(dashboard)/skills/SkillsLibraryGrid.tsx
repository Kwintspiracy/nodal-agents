'use client';

import { Star } from '@phosphor-icons/react';
import type { SkillRow } from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';

type Props = {
  skills: SkillRow[];
};

/**
 * SkillsLibraryGrid — the design's `.sklib-grid` of `.sklib-card`s.
 * Three-column grid (responsive to 1 / 2 on smaller widths). Each card
 * uses the canonical MarketplaceCard primitive with skill-coloured disc.
 *
 * Fields omitted vs the design mock (we don't track them):
 *   - StageBadge (Stable/Beta/Review) → no stage column in agent_skills
 *   - ProBadge → no premium tier
 *   - Category line → kept as derived "BUILT-IN" / "CUSTOM" tag based on
 *     contentOverridden, so callers can still scan-distinguish stock
 *     vs custom-edited skills at a glance.
 */
export default function SkillsLibraryGrid({ skills }: Props) {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {skills.map((s) => (
        <MarketplaceCard
          key={s.id}
          glyph={<Star size={18} weight="fill" />}
          glyphVariant="skill"
          name={s.name}
          description={s.description ?? <span className="font-mono">{s.slug}</span>}
          category={s.contentOverridden ? 'Customised' : 'Default'}
          foot={
            <MarketplaceCardActions
              status={
                s.assignmentCount > 0
                  ? `Used by ${s.assignmentCount} ${s.assignmentCount === 1 ? 'agent' : 'agents'}`
                  : 'Not assigned'
              }
              ctaLabel="Assign"
              ctaVariant="coral"
              ctaHref={`/skills/${s.id}/edit`}
            />
          }
        />
      ))}
    </div>
  );
}
