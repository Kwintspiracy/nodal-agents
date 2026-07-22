'use client';

import { useMemo, useState } from 'react';
import { Plus, CloudArrowDown } from '@phosphor-icons/react';
import { COMMUNITY_SKILL_CATALOG } from '@nodal-agents/shared';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import { isToolGroupSkill } from '@/lib/skill-tool-groups.ts';
import { segmentSkillsByProvenance } from '@/lib/skill-provenance.ts';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import ChipRow from '@/components/ui/ChipRow';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal.tsx';
import SkillsAssignedTable from './SkillsAssignedTable.tsx';
import CommunitySkillsGrid from './CommunitySkillsGrid.tsx';
import InstallCommunitySkillModal from './InstallCommunitySkillModal.tsx';
import SkillForm from './SkillForm.tsx';

type Tab = 'workspace' | 'community';

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
 * SkillsClient — /skills. Two views via the [Workspace | Community] toggle:
 *   - Workspace: EVERY skill installed on the workspace — assigned or not,
 *                built-ins included — grouped by provenance segments, so each
 *                skill has a home with an edit path (built-ins were previously
 *                reachable only from an agent's Skills tab, with no way to
 *                edit their content). Tool-group skills stay out: they are
 *                capability toggles on the agent's Tools tab, not skills.
 *   - Community: the community catalog as uniform tiles, filtered by
 *                content-category chips (Development, Finance, Office, …).
 */
export default function SkillsClient({ skills, agents }: Props) {
  const workspaceSkills = useMemo(() => skills.filter((s) => !isToolGroupSkill(s)), [skills]);
  const installedCommunitySkills = useMemo(
    () =>
      skills
        .filter((s) => s.isCommunity)
        .map((s) => ({
          slug: s.slug,
          updateAvailable: s.updateAvailable,
          updateDetail: s.updateDetail,
          hasScripts: Boolean(s.installedScripts && s.installedScripts.length > 0),
        })),
    [skills],
  );

  const [tab, setTab] = useState<Tab>('workspace');
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [newSkillOpen, setNewSkillOpen] = useState(false);

  const workspaceSegments = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? workspaceSkills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
        )
      : workspaceSkills;
    return segmentSkillsByProvenance(filtered);
  }, [workspaceSkills, query]);

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
                  { value: 'workspace', label: 'Workspace', count: workspaceSkills.length },
                  { value: 'community', label: 'Community', count: COMMUNITY_SKILL_CATALOG.length },
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
                <PrimaryButton variant="coral" onClick={() => setNewSkillOpen(true)}>
                  <Plus size={13} weight="bold" />
                  New Skill
                </PrimaryButton>
              </div>
            }
          />
          {tab === 'community' && (
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

      {/* New skill — non-dismissable Modal (UX-B6). The dedicated /skills/new
          route stays live for deep-links; both hosts render the same
          SkillForm. `defaultOpen` skips the form's own collapsed toggle —
          the Modal itself is the toggle here. */}
      <Modal
        open={newSkillOpen}
        onClose={() => setNewSkillOpen(false)}
        title="New skill"
        dismissable={false}
        className="max-w-3xl"
      >
        <SkillForm mode="create" defaultOpen onClose={() => setNewSkillOpen(false)} />
      </Modal>

      {tab === 'workspace' ? (
        workspaceSegments.length === 0 ? (
          <EmptyState
            title={
              query.trim()
                ? 'No skill matches your search.'
                : 'No skills on this workspace yet. Browse the Community tab to install one.'
            }
          />
        ) : (
          <SkillsAssignedTable segments={workspaceSegments} agents={agents} />
        )
      ) : (
        <CommunitySkillsGrid
          installedSkills={installedCommunitySkills}
          query={query}
          category={category}
        />
      )}
    </PageShell>
  );
}
