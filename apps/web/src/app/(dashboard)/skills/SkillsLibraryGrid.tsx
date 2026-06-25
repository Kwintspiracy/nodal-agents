'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import AvatarStack from '@/components/ui/AvatarStack';
import AssignSkillModal from './AssignSkillModal.tsx';

type Props = {
  skills: SkillRow[];
  agents: AgentRow[];
};

/**
 * SkillsLibraryGrid — grid of built-in (system) skill cards built on the
 * MarketplaceCard primitive. The Assign CTA opens a modal that lists workspace
 * agents and lets the user toggle assignment per-agent in place.
 */
export default function SkillsLibraryGrid({ skills, agents }: Props) {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {skills.map((s) => (
        <SkillCard key={s.id} skill={s} agents={agents} />
      ))}
    </div>
  );
}

function SkillCard({ skill, agents }: { skill: SkillRow; agents: AgentRow[] }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <MarketplaceCard
        name={skill.name}
        description={skill.description ?? <span className="font-mono">{skill.slug}</span>}
        foot={
          <MarketplaceCardActions
            status={
              skill.assignmentCount > 0 ? (
                <AvatarStack
                  avatars={skill.assignedAgents}
                  max={4}
                  label={`+${skill.assignmentCount}`}
                />
              ) : (
                <span className="font-mono text-[12px] text-ink-4">Unassigned</span>
              )
            }
            ctaLabel="Assign"
            ctaVariant="coral"
            onCta={() => setModalOpen(true)}
            secondary={
              <Link
                href={`/skills/${skill.id}/edit`}
                className="inline-flex h-[30px] items-center rounded-[7px] border border-rule bg-paper px-3 text-[13px] font-medium leading-none text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              >
                Customise
              </Link>
            }
          />
        }
      />

      <AssignSkillModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        skill={skill}
        agents={agents}
      />
    </>
  );
}
