'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import {
  setReflectionEnabledAction,
  archiveLearnedSkillAction,
  restoreLearnedSkillAction,
  deleteLearnedSkillAction,
} from '@/lib/learned-skills-actions.ts';
import type { LearnedSkillRow } from '@/lib/learned-skills-actions.ts';

type Props = {
  skills: LearnedSkillRow[];
  reflectionEnabled: boolean;
};

type DialogState =
  | { type: 'archive'; skillId: string; skillName: string }
  | { type: 'delete'; skillId: string; skillName: string }
  | null;

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

export default function LearnedSkillsClient({ skills, reflectionEnabled: initialEnabled }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [localSkills, setLocalSkills] = useState<LearnedSkillRow[]>(skills);

  function handleToggle() {
    const next = !enabled;
    // Optimistic UI
    setEnabled(next);
    startTransition(async () => {
      const result = await setReflectionEnabledAction(next);
      if (!result.ok) {
        setEnabled(!next); // revert
        toast.error(result.message);
      } else {
        toast.success(next ? 'Agent learning enabled' : 'Agent learning disabled');
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
          prev.map((s) =>
            s.id === skillId ? { ...s, state: 'active', archivedAt: null } : s,
          ),
        );
      }
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
      <div className="mb-6 rounded-2xl border border-rule-2 bg-paper p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-ink">Agent learning</p>
            <p className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
              When on, your agents save reusable techniques as skills after substantial tasks. You
              can review and undo everything here.
            </p>
          </div>
          <button
            type="button"
            role="switch"
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
                </button>

                <div className="flex items-center gap-2 shrink-0">
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
    </div>
  );
}
