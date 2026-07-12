'use client';

import { useMemo, useState } from 'react';
import { Plus, CloudArrowDown } from '@phosphor-icons/react';
import { COMMUNITY_SKILL_CATALOG } from '@nodal-agents/shared';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import ChipRow from '@/components/ui/ChipRow';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import EmptyState from '@/components/ui/EmptyState';
import SkillsAssignedTable from './SkillsAssignedTable.tsx';
import CommunitySkillsGrid from './CommunitySkillsGrid.tsx';
import InstallCommunitySkillModal from './InstallCommunitySkillModal.tsx';

type Tab = 'assigned' | 'library';

// Content-category chips, derived from the catalog (no hardcoded list) — these
// replace the old Built-in / Community / Custom source split.
const CATEGORIES: string[] = [
  'All',
  ...Array.from(new Set(COMMUNITY_SKILL_CATALOG.map((e) => e.category))),
];

type Props = {
  skills: SkillRow[];
  agents: AgentRow[];
};

/**
 * SkillsClient — /skills. Two views via the [Assigned | Library] toggle:
 *   - Assigned: skills wired to ≥1 agent (management table).
 *   - Library:  the whole catalog as uniform tiles, filtered by content-category
 *               chips (Development, Finance, Office, Media, …). One rendering for
 *               every skill — no more three-different-looking sub-tabs.
 */
export default function SkillsClient({ skills, agents }: Props) {
  const assignedSkills = useMemo(
    () => skills.filter((s) => s.assignmentCount > 0 && s.systemKind !== 'agent-internal'),
    [skills],
  );
  const installedSlugs = useMemo(() => skills.map((s) => s.slug), [skills]);

  const [tab, setTab] = useState<Tab>(assignedSkills.length > 0 ? 'assigned' : 'library');
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [installModalOpen, setInstallModalOpen] = useState(false);

  const filteredAssigned = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assignedSkills;
    return assignedSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
    );
  }, [assignedSkills, query]);

  return (
    <PageShell
      title="Skills"
      subtitle={`${skills.length} reusable instructions`}
      toolbar={
        <>
          <PageTopBar
            tabs={
              <PillTabs2
                value={tab}
                onChange={(v) => {
                  setTab(v);
                  setQuery('');
                }}
                tabs={[
                  { value: 'assigned', label: 'Assigned', count: assignedSkills.length },
                  { value: 'library', label: 'Library', count: COMMUNITY_SKILL_CATALOG.length },
                ]}
              />
            }
            search={
              <PageSearchInput value={query} onChange={setQuery} placeholder="Search skill…" />
            }
            cta={
              <div className="flex items-center gap-2">
                <PrimaryButton
                  variant="neutral"
                  onClick={() => setInstallModalOpen(true)}
                  className="!border-black/10 !bg-white !text-[#161616] hover:!bg-[#f2f2f2]"
                >
                  <CloudArrowDown size={13} weight="bold" />
                  Install skill
                </PrimaryButton>
                <PrimaryButton variant="coral" href="/skills/new">
                  <Plus size={13} weight="bold" />
                  New Skill
                </PrimaryButton>
              </div>
            }
          />
          {tab === 'library' && (
            <ChipRow
              className="mt-3"
              value={category}
              onChange={setCategory}
              items={CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          )}
        </>
      }
    >
      <InstallCommunitySkillModal
        open={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
      />

      {tab === 'assigned' ? (
        assignedSkills.length === 0 ? (
          <EmptyState title="No skills assigned to any agent yet. Browse the Library to add one." />
        ) : (
          <SkillsAssignedTable skills={filteredAssigned} agents={agents} />
        )
      ) : (
        <CommunitySkillsGrid installedSlugs={installedSlugs} query={query} category={category} />
      )}
    </PageShell>
  );
}
