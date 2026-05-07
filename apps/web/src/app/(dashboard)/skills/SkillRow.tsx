'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  deleteSkillAction,
  listSkillAssignmentsAction,
  assignSkillAction,
  unassignSkillAction,
  type SkillRow,
  type SkillAssignmentRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  skill: SkillRow;
}

export default function SkillRowComponent({ skill }: Props) {
  const [open, setOpen] = useState(false);
  const [assignments, setAssignments] = useState<SkillAssignmentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open || assignments) return;
    // Lazy fetch on first expand: setLoading(true) gates the spinner while the
    // server action resolves. This is the standard "fetch on open" pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    listSkillAssignmentsAction(skill.id).then((r) => {
      setLoading(false);
      if (r.ok) setAssignments(r.data);
      else toast.error(r.message);
    });
  }, [open, assignments, skill.id]);

  function toggleAssignment(agentId: string, isAssigned: boolean) {
    // Optimistic UI update
    setAssignments((prev) =>
      prev ? prev.map((a) => (a.agentId === agentId ? { ...a, assigned: !isAssigned } : a)) : prev,
    );
    startTransition(async () => {
      const action = isAssigned ? unassignSkillAction : assignSkillAction;
      const r = await action({ skillId: skill.id, agentId });
      if (!r.ok) {
        toast.error(r.message);
        // Roll back optimistic
        setAssignments((prev) =>
          prev
            ? prev.map((a) => (a.agentId === agentId ? { ...a, assigned: isAssigned } : a))
            : prev,
        );
      } else {
        toast.success(isAssigned ? 'Skill unassigned' : 'Skill assigned');
      }
    });
  }

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteSkillAction(skill.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Skill deleted');
    });
  }

  const liveCount = assignments
    ? assignments.filter((a) => a.assigned).length
    : skill.assignmentCount;

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 text-left flex items-center gap-3 hover:bg-neutral-800/30 -m-2 p-2 rounded-lg"
        >
          <span className="text-neutral-500 text-xs font-mono w-3">{open ? '▾' : '▸'}</span>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white font-medium">{skill.name}</span>
              <code className="font-mono text-xs text-neutral-500">{skill.slug}</code>
              {!skill.active && (
                <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                  inactive
                </span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-neutral-500 mt-0.5">{skill.description}</p>
            )}
          </div>
          <span className="text-xs text-neutral-500 shrink-0">{liveCount} assigned</span>
        </button>

        <Link
          href={`/skills/${skill.id}/edit`}
          className="shrink-0 px-2.5 py-1 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-600 hover:text-white transition-colors"
        >
          Edit
        </Link>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          className="shrink-0 px-2.5 py-1 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete skill "${skill.name}"?`}
        message="The skill and all its agent assignments will be removed. Existing job logs are kept."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />

      {open && (
        <div className="border-t border-neutral-800/60 px-5 py-4 space-y-4 bg-neutral-950/40">
          <div>
            <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
              Instructions
            </h4>
            <pre className="text-xs text-neutral-300 font-mono whitespace-pre-wrap break-words bg-neutral-950 border border-neutral-800/40 rounded-md p-3 max-h-64 overflow-y-auto">
              {skill.content}
            </pre>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
              Assigned to
            </h4>
            {loading ? (
              <p className="text-xs text-neutral-600">Loading…</p>
            ) : !assignments || assignments.length === 0 ? (
              <p className="text-xs text-neutral-600">
                No agents in this workspace yet. Create one on the Agents page.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {assignments.map((a) => (
                  <label
                    key={a.agentId}
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer hover:bg-neutral-800/40"
                  >
                    <input
                      type="checkbox"
                      checked={a.assigned}
                      onChange={() => toggleAssignment(a.agentId, a.assigned)}
                      className="accent-violet-500"
                    />
                    <span className="text-white">{a.agentName}</span>
                    <span className="font-mono text-xs text-neutral-500 ml-auto">
                      {a.agentSlug}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
