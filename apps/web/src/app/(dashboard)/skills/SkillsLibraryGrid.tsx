'use client';

import type { SkillRow } from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';

type Props = {
  skills: SkillRow[];
};

/**
 * SkillsLibraryGrid — grid of skill cards built on the MarketplaceCard
 * primitive. Skills are text behaviours with no per-skill icon, so the card
 * renders name + description + the Assign action (no glyph, no category tag).
 */
export default function SkillsLibraryGrid({ skills }: Props) {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {skills.map((s) => (
        <MarketplaceCard
          key={s.id}
          name={s.name}
          description={s.description ?? <span className="font-mono">{s.slug}</span>}
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
