'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  assignSkillAction,
  unassignSkillAction,
  setCliDefaultsAction,
  type SkillRow,
  type AgentRow,
} from '@/lib/actions.ts';
import { isToolGroupSkill } from '@/lib/skill-tool-groups.ts';
import Switch from '@/components/ui/Switch';
import DisclosureButton from '@/components/ui/DisclosureButton';
import MonoCode from '@/components/ui/MonoCode';
import TextButton from '@/components/ui/TextButton';
import Modal from '@/components/ui/Modal.tsx';
import { ProviderRow } from './CodeTaskProviderRow.tsx';

// The code-task tool group carries extra configuration (per-provider health
// check + model/effort defaults) that the other tool groups don't need — see
// CodeTaskConfigPanel below. Hardcoding this one slug here is the same
// exception CodeTaskSection (Autonomy tab) already makes: isToolGroupSkill
// stays generic for WHICH skills land on this tab, but a specific skill can
// still own extra, feature-specific UI once it's here.
const CODE_TASK_SKILL_SLUG = 'code-task';

/**
 * ToolsTab — the Tools tab on the agent composer.
 *
 * Product decision (Quentin, 17/07): system skills that exist purely to GATE a
 * bundle of native builtins (office-editing → xlsx/docx/pptx, command-execution
 * → run_command) are surfaced here as toggleable TOOL GROUPS instead of as
 * "skills" — same underlying storage (agent_skill_assignments via
 * assignSkillAction/unassignSkillAction), different surface. They're excluded
 * from the Skills tab and /skills entirely (see isToolGroupSkill /
 * SkillsClient.tsx). No hardcoded slugs — `allSkills` is filtered generically
 * via `isToolGroupSkill`, so a future tool-gating system skill lands here on
 * its own.
 *
 * Each card: name + description, a Switch for on/off, a disclosure listing
 * the gated tool names (from `requiredBuiltins`), and an "Includes guidance"
 * badge opening a read-only Modal with the skill's full `content` — the same
 * markdown that would otherwise only be visible by editing the skill.
 */

type Props = {
  agentId: string;
  attachedSkills: SkillRow[];
  allSkills: SkillRow[];
  /** agents.cli_defaults — per-provider model/effort for the code-task group's panel. */
  cliDefaults: AgentRow['cliDefaults'];
  onChanged: () => void;
};

export default function ToolsTab({
  agentId,
  attachedSkills,
  allSkills,
  cliDefaults,
  onChanged,
}: Props) {
  const groups = allSkills.filter(isToolGroupSkill);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(
    () => new Set(attachedSkills.filter(isToolGroupSkill).map((s) => s.id)),
  );

  function toggle(skill: SkillRow, nextAssigned: boolean) {
    // Optimistic update, reverted on failure — same shape as SkillsTab's toggle.
    setAssignedIds((prev) => {
      const next = new Set(prev);
      if (nextAssigned) next.add(skill.id);
      else next.delete(skill.id);
      return next;
    });
    const action = nextAssigned ? assignSkillAction : unassignSkillAction;
    void action({ skillId: skill.id, agentId }).then((result) => {
      if (!result.ok) {
        setAssignedIds((prev) => {
          const next = new Set(prev);
          if (nextAssigned) next.delete(skill.id);
          else next.add(skill.id);
          return next;
        });
        toast.error(result.message);
        return;
      }
      toast.success(nextAssigned ? `${skill.name} enabled` : `${skill.name} disabled`);
      onChanged();
    });
  }

  if (groups.length === 0) {
    // Not reachable today (office-editing + command-execution always exist as
    // system skills) — guarded so a future catalog change can't crash this tab.
    return (
      <div className="rounded-2xl border border-rule-2 bg-paper p-6">
        <p className="text-body-13 text-ink-3">No tool groups available on this workspace.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-body-13 text-ink-3">
        Native tool bundles this agent can use. Each toggle grants the underlying tools directly,
        with usage guidance included.
      </p>
      {groups.map((skill) => (
        <ToolGroupCard
          key={skill.id}
          skill={skill}
          assigned={assignedIds.has(skill.id)}
          onToggle={(next) => toggle(skill, next)}
          agentId={agentId}
          cliDefaults={skill.slug === CODE_TASK_SKILL_SLUG ? cliDefaults : null}
        />
      ))}
    </div>
  );
}

function ToolGroupCard({
  skill,
  assigned,
  onToggle,
  agentId,
  cliDefaults,
}: {
  skill: SkillRow;
  assigned: boolean;
  onToggle: (next: boolean) => void;
  agentId: string;
  /** Non-null only for the code-task card — see the CODE_TASK_SKILL_SLUG filter above. */
  cliDefaults: AgentRow['cliDefaults'];
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const tools = skill.requiredBuiltins;
  const isCodeTask = skill.slug === CODE_TASK_SKILL_SLUG;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-rule-2 bg-paper"
      data-testid={`tool-group-card-${skill.slug}`}
    >
      <div className="flex items-start justify-between gap-4 p-6 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-medium-15 text-ink">{skill.name}</span>
            <TextButton
              onClick={() => setGuidanceOpen(true)}
              className="inline-flex h-[22px] items-center rounded-[5px] bg-skill-vivid/15 px-2.5 text-medium-12 leading-none! text-warn hover:bg-skill-vivid/25 dark:bg-skill-vivid/20 dark:text-skill-vivid"
            >
              Includes guidance
            </TextButton>
          </div>
          {skill.description && (
            <p className="mt-1.5 text-body-13 leading-[1.5]! text-ink-3">{skill.description}</p>
          )}
        </div>

        <Switch
          checked={assigned}
          onChange={() => onToggle(!assigned)}
          ariaLabel={`Toggle ${skill.name}`}
          trackClassName={
            assigned ? 'mt-0.5 border-ok/40 bg-ok/20' : 'mt-0.5 border-rule-2 bg-canvas'
          }
          thumbClassName={assigned ? 'translate-x-[18px] bg-ok' : 'translate-x-[2px] bg-ink-3'}
        />
      </div>

      <div className="border-t border-rule-2">
        <DisclosureButton open={toolsOpen} onClick={() => setToolsOpen((v) => !v)}>
          <span className="text-medium-13 text-ink-2">
            {tools.length} tool{tools.length === 1 ? '' : 's'}
          </span>
        </DisclosureButton>
        {toolsOpen && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-4">
            {tools.map((t) => (
              <MonoCode key={t}>{t}</MonoCode>
            ))}
          </div>
        )}
      </div>

      {isCodeTask && assigned && (
        <CodeTaskConfigPanel agentId={agentId} cliDefaults={cliDefaults} />
      )}

      <Modal open={guidanceOpen} onClose={() => setGuidanceOpen(false)} title={skill.name}>
        <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-body-13 leading-[1.6]! text-ink-2">
          {skill.content}
        </div>
      </Modal>
    </div>
  );
}

// ─── Coding CLI configuration panel (code-task tool group only) ───────────────
//
// Per-provider health check + model/effort defaults — moved here from the
// Autonomy tab's CodeTaskSection (Quentin's correction, 19/08): those are
// capability configuration, not an autonomy setting. Autonomy keeps only the
// Yolo toggle and the daily budget.

function CodeTaskConfigPanel({
  agentId,
  cliDefaults,
}: {
  agentId: string;
  cliDefaults: AgentRow['cliDefaults'];
}) {
  async function handleSaveDefaults(
    provider: 'claude' | 'codex',
    model: string | null,
    effort: string | null,
  ) {
    const result = await setCliDefaultsAction({ agentId, provider, model, effort });
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success('Coding CLI defaults saved');
  }

  return (
    <div className="space-y-2.5 border-t border-rule-2 p-4">
      <div className="text-mono-11 uppercase tracking-[0.12em] text-ink-4">
        Diagnostics and defaults
      </div>
      <ProviderRow
        label="Claude Code"
        provider="claude"
        defaults={cliDefaults?.claude}
        onSaveDefaults={(model, effort) => handleSaveDefaults('claude', model, effort)}
      />
      <ProviderRow
        label="Codex"
        provider="codex"
        defaults={cliDefaults?.codex}
        onSaveDefaults={(model, effort) => handleSaveDefaults('codex', model, effort)}
      />
    </div>
  );
}
