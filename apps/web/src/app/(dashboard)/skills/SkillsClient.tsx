'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus } from '@phosphor-icons/react';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import PageHeader from '@/components/ui/PageHeader';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SkillsAssignedTable from './SkillsAssignedTable.tsx';
import SkillsLibraryGrid from './SkillsLibraryGrid.tsx';

type Tab = 'mine' | 'library';

type Props = {
  skills: SkillRow[];
  agents: AgentRow[];
};

function matchesQuery(s: SkillRow, q: string): boolean {
  return s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q);
}

/**
 * SkillsClient — interactive shell for /skills. The two tabs split by SOURCE
 * (mirroring the Connectors page): "My skills" = the skills the user authored
 * (assigned or not), "Library" = the fixed built-in catalog. A user-created
 * skill therefore never pollutes the Library; built-in skills are managed from
 * their Library card's Assign modal.
 *
 * Tab selection is local React state — a fresh visit lands on Library when the
 * user hasn't authored a skill yet (better empty-state framing).
 */
export default function SkillsClient({ skills, agents }: Props) {
  const mySkills = useMemo(() => skills.filter((s) => !s.isSystem), [skills]);
  const librarySkills = useMemo(() => skills.filter((s) => s.isSystem), [skills]);
  const [tab, setTab] = useState<Tab>(mySkills.length > 0 ? 'mine' : 'library');
  const [query, setQuery] = useState('');

  const filteredMine = useMemo(() => {
    if (!query.trim()) return mySkills;
    const q = query.toLowerCase();
    return mySkills.filter((s) => matchesQuery(s, q));
  }, [mySkills, query]);

  const filteredLibrary = useMemo(() => {
    if (!query.trim()) return librarySkills;
    const q = query.toLowerCase();
    return librarySkills.filter((s) => matchesQuery(s, q));
  }, [librarySkills, query]);

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
              { value: 'mine', label: 'My skills', count: mySkills.length },
              { value: 'library', label: 'Library', count: librarySkills.length },
            ]}
          />
        }
        search={
          <PageSearchInput
            value={query}
            onChange={setQuery}
            placeholder={tab === 'mine' ? 'Search your skills…' : 'Search the library…'}
          />
        }
        cta={
          <PrimaryButton variant="coral" href="/skills/new">
            <Plus size={13} weight="bold" />
            Create skill
          </PrimaryButton>
        }
      />

      <div className="pt-5">
        {tab === 'mine' ? (
          mySkills.length === 0 ? (
            <EmptyMine onBrowse={() => setTab('library')} />
          ) : (
            <SkillsAssignedTable skills={filteredMine} agents={agents} />
          )
        ) : librarySkills.length === 0 ? (
          <EmptyLibrary />
        ) : (
          <SkillsLibraryGrid skills={filteredLibrary} agents={agents} />
        )}
      </div>
    </div>
  );
}

function EmptyMine({ onBrowse }: { onBrowse: () => void }) {
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
          or browse the Library
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
