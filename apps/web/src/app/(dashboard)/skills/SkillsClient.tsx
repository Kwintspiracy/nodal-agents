'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, CloudArrowDown } from '@phosphor-icons/react';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { COMMUNITY_SKILL_CATALOG } from '@nodal-agents/shared';
import SkillsAssignedTable from './SkillsAssignedTable.tsx';
import SkillsLibraryGrid from './SkillsLibraryGrid.tsx';
import CommunitySkillsGrid from './CommunitySkillsGrid.tsx';
import InstallCommunitySkillModal from './InstallCommunitySkillModal.tsx';

type Tab = 'assigned' | 'custom' | 'library' | 'community';

type Props = {
  skills: SkillRow[];
  agents: AgentRow[];
};

function matchesQuery(s: SkillRow, q: string): boolean {
  return s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q);
}

/**
 * SkillsClient — interactive shell for /skills. Three tabs, each answering a
 * distinct question so the list never reads as "I only have N skills":
 *   - Assigned       → skills currently wired to ≥1 agent (table)
 *   - Custom         → skills the user authored, assigned or not (table)
 *   - Built-in Library → the fixed shipped catalog (card grid)
 *
 * Assigned is a cross-cut by state; Custom / Built-in split by source. An
 * assigned custom skill therefore legitimately shows under both Assigned and
 * Custom — the labels make the relationship clear.
 *
 * Tab selection is local React state; the landing tab is the first non-empty
 * one (Assigned → Custom → Built-in Library).
 */
export default function SkillsClient({ skills, agents }: Props) {
  const assignedSkills = useMemo(
    // Only capability/custom skills are ever assigned; baseline/channel/internal
    // are part of every agent or loaded on demand and never appear as assigned.
    () => skills.filter((s) => s.assignmentCount > 0 && s.systemKind !== 'agent-internal'),
    [skills],
  );
  const customSkills = useMemo(() => skills.filter((s) => !s.isSystem), [skills]);
  // Library = opt-in CAPABILITY skills only. baseline (intrinsic, every agent),
  // channel (auto when bound), and agent-internal skills are not user-managed.
  const librarySkills = useMemo(
    () => skills.filter((s) => s.systemKind === 'capability'),
    [skills],
  );
  // Installed slugs drive the "Installed" state on community catalog cards.
  const installedSlugs = useMemo(() => skills.map((s) => s.slug), [skills]);

  const initialTab: Tab =
    assignedSkills.length > 0 ? 'assigned' : customSkills.length > 0 ? 'custom' : 'library';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState('');
  const [installModalOpen, setInstallModalOpen] = useState(false);

  const active =
    tab === 'assigned' ? assignedSkills : tab === 'custom' ? customSkills : librarySkills;
  const filtered = useMemo(() => {
    if (!query.trim()) return active;
    const q = query.toLowerCase();
    return active.filter((s) => matchesQuery(s, q));
  }, [active, query]);

  return (
    <div className="pb-10">
      <PageHeader
        title="Skills"
        subtitle={`${skills.length} reusable instruction${skills.length === 1 ? '' : 's'} you can attach to any agent.`}
      />
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
              { value: 'custom', label: 'Custom', count: customSkills.length },
              { value: 'library', label: 'Built-in Library', count: librarySkills.length },
              { value: 'community', label: 'Community', count: COMMUNITY_SKILL_CATALOG.length },
            ]}
          />
        }
        search={
          <PageSearchInput
            value={query}
            onChange={setQuery}
            placeholder={
              tab === 'assigned'
                ? 'Search assigned skills…'
                : tab === 'custom'
                  ? 'Search your skills…'
                  : tab === 'community'
                    ? 'Search community skills…'
                    : 'Search the library…'
            }
          />
        }
        cta={
          <div className="flex items-center gap-2">
            <PrimaryButton variant="ink" onClick={() => setInstallModalOpen(true)}>
              <CloudArrowDown size={13} weight="bold" />
              Install skill
            </PrimaryButton>
            <PrimaryButton variant="coral" href="/skills/new">
              <Plus size={13} weight="bold" />
              Create skill
            </PrimaryButton>
          </div>
        }
      />

      <InstallCommunitySkillModal
        open={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
      />

      <div className="pt-5">
        {tab === 'assigned' ? (
          assignedSkills.length === 0 ? (
            <EmptyAssigned />
          ) : (
            <SkillsAssignedTable skills={filtered} agents={agents} />
          )
        ) : tab === 'custom' ? (
          customSkills.length === 0 ? (
            <EmptyCustom onBrowse={() => setTab('library')} />
          ) : (
            <SkillsAssignedTable skills={filtered} agents={agents} />
          )
        ) : tab === 'community' ? (
          <CommunitySkillsGrid installedSlugs={installedSlugs} query={query} />
        ) : librarySkills.length === 0 ? (
          <EmptyLibrary />
        ) : (
          <SkillsLibraryGrid skills={filtered} agents={agents} />
        )}
      </div>
    </div>
  );
}

function EmptyAssigned() {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">
        No skills assigned to any agent yet.
        <br />
        Assign one from the Custom or Built-in Library tab.
      </p>
    </div>
  );
}

function EmptyCustom({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">
        You haven&apos;t created any skills yet — skills are reusable instructions you append to an
        agent&apos;s system prompt when assigned.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2.5">
        <Link
          href="/skills/new"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-skill-vivid px-3.5 text-[13px] font-medium leading-none text-white transition-[filter] hover:brightness-[0.94]"
        >
          <Plus size={13} weight="bold" />
          Create a skill
        </Link>
        <button
          type="button"
          onClick={onBrowse}
          className="text-[13px] font-medium text-ink-3 underline underline-offset-2 hover:text-ink"
        >
          or browse the Built-in Library
        </button>
      </div>
    </div>
  );
}

function EmptyLibrary() {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">No built-in skills available.</p>
    </div>
  );
}
