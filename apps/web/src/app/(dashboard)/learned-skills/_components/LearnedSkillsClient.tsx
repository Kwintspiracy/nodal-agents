'use client';

import { useState, useTransition, useCallback } from 'react';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import Modal from '@/components/ui/Modal.tsx';
import { OptionRadio } from '@/components/ui/OptionRadio.tsx';
import {
  setReflectionEnabledAction,
  archiveLearnedSkillAction,
  restoreLearnedSkillAction,
  deleteLearnedSkillAction,
  setSkillAssignmentModeAction,
  assignLearnedSkillAction,
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

type AssignModalState = {
  skillId: string;
  skillName: string;
  defaultAgentId: string | null;
} | null;

function StateBadge({ state }: { state: string }) {
  if (state === 'active') {
    return (
      <span className="inline-flex items-center rounded-full bg-ok/15 px-2 py-0.5 text-[11px] font-medium text-ok">
        active
      </span>
    );
  }
  if (state === 'stale') {
    return (
      <span className="inline-flex items-center rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
        stale
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ink-5/40 px-2 py-0.5 text-[11px] font-medium text-ink-3">
      archived
    </span>
  );
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
  const [assignModal, setAssignModal] = useState<AssignModalState>(null);
  const [assigningAgentId, setAssigningAgentId] = useState<string>('');

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

  const openAssignModal = useCallback(
    (skill: LearnedSkillRow) => {
      const defaultAgentId = skill.createdByAgentId ?? null;
      setAssigningAgentId(defaultAgentId ?? assignableAgents[0]?.id ?? '');
      setAssignModal({ skillId: skill.id, skillName: skill.name, defaultAgentId });
    },
    [assignableAgents],
  );

  function handleAssignConfirm() {
    if (!assignModal || !assigningAgentId) return;
    const { skillId, skillName } = assignModal;
    setAssignModal(null);

    startTransition(async () => {
      const result = await assignLearnedSkillAction(skillId, assigningAgentId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const agent = assignableAgents.find((a) => a.id === assigningAgentId);
      const agentName = agent?.name ?? 'agent';
      toast.success(`"${skillName}" assigned to ${agentName}`);
      setLocalSkills((prev) =>
        prev.map((s) =>
          s.id === skillId
            ? {
                ...s,
                assignedAgentNames: s.assignedAgentNames.includes(agentName)
                  ? s.assignedAgentNames
                  : [...s.assignedAgentNames, agentName],
              }
            : s,
        ),
      );
    });
  }

  return (
    <div className="pb-10">
      {/* Header */}
      <div className="py-7">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Learned Skills
        </h1>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
          Skills your agents discovered and saved automatically.
        </p>
      </div>

      {/* Reflection toggle section */}
      <div className="mb-4 rounded-2xl border border-rule-2 bg-paper p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p id="agent-learning-label" className="text-[13px] font-medium text-ink">
              Agent learning
            </p>
            <p id="agent-learning-desc" className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
              When on, your agents save reusable techniques as skills after substantial tasks. You
              can review and undo everything here.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-labelledby="agent-learning-label"
            aria-describedby="agent-learning-desc"
            aria-checked={enabled}
            onClick={handleToggle}
            disabled={isPending}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
              enabled ? 'bg-ok' : 'bg-ink-4'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform duration-200 ${
                enabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Assignment mode section */}
      <div className="mb-6 rounded-2xl border border-rule-2 bg-paper p-5">
        <p id="assign-mode-label" className="mb-1 text-[13px] font-medium text-ink">
          When an agent learns a new skill
        </p>
        <p id="assign-mode-desc" className="mb-4 text-[12px] leading-[1.5] text-ink-3">
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
            description="New skills are created unassigned — you assign them manually from this page."
          />
        </div>
      </div>

      {/* Skills list */}
      {localSkills.length === 0 ? (
        <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
          <p className="text-[13px] leading-[1.5] text-ink-3">
            Your agents haven&apos;t learned anything yet. Enable agent learning above to get
            started.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {localSkills.map((skill) => (
            <div
              key={skill.id}
              className="rounded-2xl border border-rule-2 bg-paper overflow-hidden"
            >
              <div className="flex items-center gap-3 px-5 py-3.5">
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink truncate">{skill.name}</span>
                    <StateBadge state={skill.state} />
                    {skill.patchCount > 0 && (
                      <span className="text-[11px] text-ink-3">
                        {skill.patchCount} patch{skill.patchCount !== 1 ? 'es' : ''}
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 text-[12px] text-ink-3 truncate">{skill.description}</p>
                  )}
                  {/* Assignment line */}
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {skill.assignedAgentNames.length > 0
                      ? `Assigned to ${skill.assignedAgentNames.join(', ')}`
                      : 'Not assigned'}
                  </p>
                </button>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Assign button — only for unassigned skills */}
                  {skill.assignedAgentNames.length === 0 && assignableAgents.length > 0 && (
                    <button
                      type="button"
                      onClick={() => openAssignModal(skill)}
                      disabled={isPending}
                      className="px-2.5 py-1 text-[12px] font-medium text-ink-2 border border-rule rounded-lg hover:border-rule-2 hover:text-ink transition-colors disabled:opacity-50"
                    >
                      Assign
                    </button>
                  )}
                  {skill.state === 'archived' ? (
                    <button
                      type="button"
                      onClick={() => handleRestore(skill.id, skill.name)}
                      disabled={isPending}
                      className="px-2.5 py-1 text-[12px] font-medium text-ink-2 border border-rule rounded-lg hover:border-rule-2 hover:text-ink transition-colors disabled:opacity-50"
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setDialog({ type: 'archive', skillId: skill.id, skillName: skill.name })
                      }
                      disabled={isPending}
                      className="px-2.5 py-1 text-[12px] font-medium text-ink-2 border border-rule rounded-lg hover:border-rule-2 hover:text-ink transition-colors disabled:opacity-50"
                    >
                      Archive
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setDialog({ type: 'delete', skillId: skill.id, skillName: skill.name })
                    }
                    disabled={isPending}
                    className="px-2.5 py-1 text-[12px] font-medium text-err border border-err/30 rounded-lg hover:bg-err/5 transition-colors disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {expandedId === skill.id && (
                <div className="border-t border-rule-2 bg-canvas/50 px-5 py-4">
                  <pre className="whitespace-pre-wrap text-[12px] text-ink-2 font-mono leading-relaxed">
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

      {/* Assign modal */}
      <Modal
        open={assignModal !== null}
        onClose={() => setAssignModal(null)}
        title={assignModal ? `Assign "${assignModal.skillName}"` : undefined}
      >
        {assignModal && (
          <div className="space-y-4">
            <p className="text-[12px] text-ink-3">Select an agent to assign this skill to.</p>
            <div>
              <label
                htmlFor="assign-agent-select"
                className="mb-1.5 block text-[12px] font-medium text-ink"
              >
                Agent
              </label>
              <select
                id="assign-agent-select"
                value={assigningAgentId}
                onChange={(e) => setAssigningAgentId(e.target.value)}
                className="w-full rounded-lg border border-rule-2 bg-canvas px-3 py-2 text-[13px] text-ink focus:border-conn-vivid focus:outline-none"
              >
                {assignableAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAssignModal(null)}
                className="px-3 py-1.5 text-[13px] font-medium text-ink-2 border border-rule rounded-lg hover:border-rule-2 hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAssignConfirm}
                disabled={!assigningAgentId || isPending}
                className="px-3 py-1.5 text-[13px] font-medium text-white bg-conn-vivid rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
