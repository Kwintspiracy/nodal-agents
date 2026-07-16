'use client';

import { useState, useTransition, useMemo } from 'react';
import { toast } from 'sonner';
import { UserPlus, Archive, ArrowCounterClockwise, Trash } from '@phosphor-icons/react';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PageSearchInput from '@/components/ui/PageSearchInput';
import EmptyState from '@/components/ui/EmptyState';
import RowActionButton from '@/components/ui/RowActionButton';
import { OptionRadio } from '@/components/ui/OptionRadio.tsx';
import Switch from '@/components/ui/Switch';
import StatusPill from '@/components/ui/StatusPill';
import AssignSkillModal from '@/app/(dashboard)/skills/AssignSkillModal.tsx';
import {
  setReflectionEnabledAction,
  archiveLearnedSkillAction,
  restoreLearnedSkillAction,
  deleteLearnedSkillAction,
  setSkillAssignmentModeAction,
  assignLearnedSkillAction,
  unassignLearnedSkillAction,
} from '@/lib/learned-skills-actions.ts';
import type { LearnedSkillRow } from '@/lib/learned-skills-actions.ts';

type AssignableAgent = { id: string; name: string; slug: string };

type Props = {
  skills: LearnedSkillRow[];
  reflectionEnabled: boolean;
  assignmentMode: 'auto' | 'approval';
  assignableAgents: AssignableAgent[];
};

type DialogState =
  | { type: 'archive'; skillId: string; skillName: string }
  | { type: 'delete'; skillId: string; skillName: string }
  | null;

function StateBadge({ state }: { state: string }) {
  if (state === 'active') return <StatusPill variant="lvl-ok" label="active" />;
  if (state === 'stale') return <StatusPill variant="lvl-warn" label="stale" />;
  return <StatusPill variant="idle" label="archived" />;
}

export default function LearnedSkillsClient({
  skills,
  reflectionEnabled: initialEnabled,
  assignmentMode: initialMode,
  assignableAgents,
}: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [mode, setMode] = useState<'auto' | 'approval'>(initialMode);
  const [isPending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [localSkills, setLocalSkills] = useState<LearnedSkillRow[]>(skills);
  const [assignSkillId, setAssignSkillId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const assignSkill = assignSkillId ? localSkills.find((s) => s.id === assignSkillId) : undefined;

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return localSkills;
    return localSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
    );
  }, [localSkills, query]);

  function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      const result = await setReflectionEnabledAction(next);
      if (!result.ok) {
        setEnabled(!next);
        toast.error(result.message);
      } else {
        toast.success(next ? 'Agent learning enabled' : 'Agent learning disabled');
      }
    });
  }

  function handleModeChange(next: 'auto' | 'approval') {
    if (next === mode) return;
    const prev = mode;
    setMode(next);
    startTransition(async () => {
      const result = await setSkillAssignmentModeAction(next);
      if (!result.ok) {
        setMode(prev);
        toast.error(result.message);
      } else {
        toast.success(
          next === 'auto'
            ? 'Skills auto-assigned to authoring agent'
            : 'Skills require your approval before assignment',
        );
      }
    });
  }

  function handleConfirm() {
    if (!dialog) return;
    const { type, skillId, skillName } = dialog;
    setDialog(null);

    startTransition(async () => {
      if (type === 'archive') {
        const result = await archiveLearnedSkillAction(skillId);
        if (!result.ok) {
          toast.error(result.message);
        } else {
          toast.success(`"${skillName}" archived`);
          setLocalSkills((prev) =>
            prev.map((s) =>
              s.id === skillId ? { ...s, state: 'archived', archivedAt: new Date() } : s,
            ),
          );
        }
      } else if (type === 'delete') {
        const result = await deleteLearnedSkillAction(skillId);
        if (!result.ok) {
          toast.error(result.message);
        } else {
          toast.success(`"${skillName}" deleted`);
          setLocalSkills((prev) => prev.filter((s) => s.id !== skillId));
        }
      }
    });
  }

  function handleRestore(skillId: string, skillName: string) {
    startTransition(async () => {
      const result = await restoreLearnedSkillAction(skillId);
      if (!result.ok) {
        toast.error(result.message);
      } else {
        toast.success(`"${skillName}" restored`);
        setLocalSkills((prev) =>
          prev.map((s) => (s.id === skillId ? { ...s, state: 'active', archivedAt: null } : s)),
        );
      }
    });
  }

  function handleAssignToggled(agentId: string, assigned: boolean) {
    const agent = assignableAgents.find((a) => a.id === agentId);
    setLocalSkills((prev) =>
      prev.map((s) => {
        if (s.id !== assignSkillId) return s;
        if (assigned) {
          if (!agent || s.assignedAgents.some((a) => a.id === agentId)) return s;
          return { ...s, assignedAgents: [...s.assignedAgents, { id: agentId, name: agent.name }] };
        }
        return { ...s, assignedAgents: s.assignedAgents.filter((a) => a.id !== agentId) };
      }),
    );
  }

  return (
    <PageShell
      title="Learned Skills"
      subtitle="Skills your agents discovered automatically."
      toolbar={
        <PageTopBar
          search={<PageSearchInput value={query} onChange={setQuery} placeholder="Search skill…" />}
        />
      }
    >
      {/* Reflection toggle section */}
      <div className="mb-4 rounded-2xl border border-rule-2 bg-paper p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p id="agent-learning-label" className="text-medium-14 text-ink">
              Agent learning
            </p>
            <p id="agent-learning-desc" className="mt-0.5 text-body-13 leading-[1.5]! text-ink-3">
              When on, your agents save reusable techniques as skills after substantial tasks. You
              can review and undo everything here.
            </p>
          </div>
          <Switch
            checked={enabled}
            onChange={handleToggle}
            disabled={isPending}
            size="sm"
            ariaLabelledBy="agent-learning-label"
            ariaDescribedBy="agent-learning-desc"
            trackClassName={enabled ? 'bg-ok' : 'bg-ink-4'}
            thumbClassName={`bg-white ${enabled ? 'translate-x-4' : 'translate-x-0'}`}
          />
        </div>
      </div>

      {/* Assignment mode section */}
      <div className="mb-6 rounded-2xl border border-rule-2 bg-paper p-5">
        <p id="assign-mode-label" className="mb-1 text-medium-14 text-ink">
          When an agent learns a new skill
        </p>
        <p id="assign-mode-desc" className="mb-4 text-body-13 leading-[1.5]! text-ink-3">
          Control whether new agent-authored skills are instantly assigned back to the agent, or
          held for your review first.
        </p>
        <div
          role="radiogroup"
          aria-labelledby="assign-mode-label"
          aria-describedby="assign-mode-desc"
        >
          <OptionRadio
            active={mode === 'auto'}
            onClick={() => handleModeChange('auto')}
            name="Auto-assign to the agent"
            description="The skill is immediately available to the agent that authored it."
          />
          <OptionRadio
            active={mode === 'approval'}
            onClick={() => handleModeChange('approval')}
            name="Require my approval"
            description="New skills are created unassigned - you assign them manually from this page."
          />
        </div>
      </div>

      {/* Skills list */}
      {localSkills.length === 0 ? (
        <EmptyState title="Your agents haven't learned anything yet. Enable agent learning above to get started." />
      ) : visibleSkills.length === 0 ? (
        <EmptyState title={`No learned skills match "${query}".`} />
      ) : (
        <div className="space-y-2">
          {visibleSkills.map((skill) => (
            <div
              key={skill.id}
              className="rounded-2xl border border-rule-2 bg-paper overflow-hidden"
            >
              <div className="flex items-center gap-3 px-5 py-3.5">
                {/* A whole multi-line block (name + badges + description + assignment
                    line) is the click target — a real <button> can't hold this rich
                    content well, so this follows the same role="button" div pattern as
                    ChatClient's ConversationRow / MemoriesClient's MemoryFact. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(expandedId === skill.id ? null : skill.id);
                    }
                  }}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-medium-14 text-ink truncate">{skill.name}</span>
                    <StateBadge state={skill.state} />
                    {skill.patchCount > 0 && (
                      <span className="text-body-12 text-ink-3">
                        {skill.patchCount} patch{skill.patchCount !== 1 ? 'es' : ''}
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 text-body-13 text-ink-3 truncate">{skill.description}</p>
                  )}
                  {/* Assignment line */}
                  <p className="mt-0.5 text-body-12 text-ink-3">
                    {skill.assignedAgents.length > 0
                      ? `Assigned to ${skill.assignedAgents.map((a) => a.name).join(', ')}`
                      : 'Not assigned'}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {assignableAgents.length > 0 && (
                    <RowActionButton
                      square
                      icon={<UserPlus size={16} />}
                      title="Assign to agents"
                      disabled={isPending}
                      onClick={() => setAssignSkillId(skill.id)}
                    />
                  )}
                  {skill.state === 'archived' ? (
                    <RowActionButton
                      square
                      icon={<ArrowCounterClockwise size={16} />}
                      title="Restore"
                      disabled={isPending}
                      onClick={() => handleRestore(skill.id, skill.name)}
                    />
                  ) : (
                    <RowActionButton
                      square
                      icon={<Archive size={16} />}
                      title="Archive"
                      disabled={isPending}
                      onClick={() =>
                        setDialog({ type: 'archive', skillId: skill.id, skillName: skill.name })
                      }
                    />
                  )}
                  <RowActionButton
                    square
                    icon={<Trash size={16} />}
                    title="Delete"
                    tone="danger"
                    disabled={isPending}
                    onClick={() =>
                      setDialog({ type: 'delete', skillId: skill.id, skillName: skill.name })
                    }
                  />
                </div>
              </div>

              {expandedId === skill.id && (
                <div className="border-t border-rule-2 bg-canvas/50 px-5 py-4">
                  <pre className="whitespace-pre-wrap text-mono-13 text-ink-2 leading-relaxed!">
                    {skill.content}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ConfirmDialog — NO window.confirm */}
      <ConfirmDialog
        open={dialog !== null}
        title={
          dialog?.type === 'archive'
            ? `Archive "${dialog.skillName}"?`
            : `Delete "${dialog?.skillName}"?`
        }
        message={
          dialog?.type === 'archive'
            ? 'The skill will be archived and hidden from agents. You can restore it later.'
            : 'This will permanently delete the skill. This action cannot be undone.'
        }
        confirmLabel={dialog?.type === 'archive' ? 'Archive' : 'Delete'}
        destructive={true}
        onConfirm={handleConfirm}
        onCancel={() => setDialog(null)}
      />

      {/* Assign modal — same per-agent toggle list as the Skills page */}
      {assignSkill && (
        <AssignSkillModal
          open
          onClose={() => setAssignSkillId(null)}
          skill={assignSkill}
          agents={assignableAgents}
          assign={({ skillId, agentId }) => assignLearnedSkillAction(skillId, agentId)}
          unassign={({ skillId, agentId }) => unassignLearnedSkillAction(skillId, agentId)}
          onToggled={handleAssignToggled}
        />
      )}
    </PageShell>
  );
}
