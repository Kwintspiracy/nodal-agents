'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Star } from '@phosphor-icons/react';
import type { SkillRow } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SkillsAssignedTable from './SkillsAssignedTable.tsx';
import SkillsLibraryGrid from './SkillsLibraryGrid.tsx';

type Tab = 'assigned' | 'library';

type Props = {
  skills: SkillRow[];
};

/**
 * SkillsClient — interactive shell for /skills. Mirrors the design's
 * `screen-skill.jsx` v4 (PillTabs2 between Assigned + Library, then either
 * a sk-tbl table or a sklib-grid card grid).
 *
 * Tab selection is local React state — URL is intentionally not used here
 * because a fresh dashboard visit lands on Library when there's no
 * assigned skill yet (better empty-state framing).
 */
export default function SkillsClient({ skills }: Props) {
  const assignedSkills = useMemo(() => skills.filter((s) => s.assignmentCount > 0), [skills]);
  const [tab, setTab] = useState<Tab>(assignedSkills.length > 0 ? 'assigned' : 'library');
  const [query, setQuery] = useState('');

  const filteredAssigned = useMemo(() => {
    if (!query.trim()) return assignedSkills;
    const q = query.toLowerCase();
    return assignedSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
    );
  }, [assignedSkills, query]);

  const filteredLibrary = useMemo(() => {
    if (!query.trim()) return skills;
    const q = query.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
    );
  }, [skills, query]);

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
              { value: 'library', label: 'Library', count: skills.length },
            ]}
          />
        }
        search={
          <PageSearchInput
            value={query}
            onChange={setQuery}
            placeholder={tab === 'assigned' ? 'Search assigned skills…' : 'Search the library…'}
          />
        }
        cta={
          tab === 'assigned' ? (
            <PrimaryButton variant="coral" onClick={() => setTab('library')}>
              <Plus size={13} weight="bold" />
              Pick from library
            </PrimaryButton>
          ) : (
            <PrimaryButton variant="coral" href="/skills/new">
              <Star size={13} weight="fill" />
              Create skill
            </PrimaryButton>
          )
        }
      />

      <div className="pt-5">
        {tab === 'assigned' ? (
          assignedSkills.length === 0 ? (
            <EmptyAssigned />
          ) : (
            <SkillsAssignedTable skills={filteredAssigned} />
          )
        ) : skills.length === 0 ? (
          <EmptyLibrary />
        ) : (
          <SkillsLibraryGrid skills={filteredLibrary} />
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
        Pick one from the Library to attach it.
      </p>
    </div>
  );
}

function EmptyLibrary() {
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
      <p className="text-[13px] leading-[1.5] text-ink-3">
        Your library is empty — skills are reusable instructions you append to an agent&apos;s
        system prompt when assigned.
      </p>
      <div className="mt-4 inline-flex">
        <Link
          href="/skills/new"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-skill-vivid px-3.5 text-[13px] font-medium leading-none text-white transition-[filter] hover:brightness-[0.94]"
        >
          <Plus size={13} weight="bold" />
          Create your first skill
        </Link>
      </div>
    </div>
  );
}
