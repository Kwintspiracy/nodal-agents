'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Link from 'next/link';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import { assignSkillAction, unassignSkillAction } from '@/lib/actions.ts';
import Modal from '@/components/ui/Modal';

type Props = {
  open: boolean;
  onClose: () => void;
  skill: SkillRow;
  agents: AgentRow[];
};

/**
 * AssignSkillModal — the per-agent assign/unassign toggle list for a skill.
 * Shared by the Library grid cards and the "My skills" table so there's a
 * single assignment surface (no duplicated picker).
 */
export default function AssignSkillModal({ open, onClose, skill, agents }: Props) {
  return (
    <Modal open={open} onClose={onClose} title={`Assign "${skill.name}"`}>
      <AssignPanel skill={skill} agents={agents} onClose={onClose} />
    </Modal>
  );
}

function AssignPanel({
  skill,
  agents,
  onClose,
}: {
  skill: SkillRow;
  agents: AgentRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  // Track assigned agent IDs locally so the toggles reflect optimistic state
  // immediately while the server confirms in the background.
  const [assignedIds, setAssignedIds] = useState<Set<string>>(
    () => new Set(skill.assignedAgents.map((a) => a.id)),
  );
  const [pending, startTransition] = useTransition();

  if (agents.length === 0) {
    return (
      <div className="space-y-3 py-6 text-center">
        <p className="text-sm text-ink-3">No agents yet — create one first.</p>
        <Link
          href="/agents"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-400 underline underline-offset-2 hover:text-blue-300"
        >
          Go to Agents
        </Link>
      </div>
    );
  }

  function toggle(agentId: string) {
    const isAssigned = assignedIds.has(agentId);
    // Optimistic update
    setAssignedIds((prev) => {
      const next = new Set(prev);
      if (isAssigned) next.delete(agentId);
      else next.add(agentId);
      return next;
    });

    startTransition(async () => {
      const payload = { skillId: skill.id, agentId };
      const result = isAssigned
        ? await unassignSkillAction(payload)
        : await assignSkillAction(payload);

      if (!result.ok) {
        // Revert optimistic update on failure
        setAssignedIds((prev) => {
          const next = new Set(prev);
          if (isAssigned) next.add(agentId);
          else next.delete(agentId);
          return next;
        });
        toast.error(result.message);
        return;
      }

      toast.success(isAssigned ? 'Skill unassigned' : 'Skill assigned');
      router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <p className="mb-3 text-xs text-ink-3">
        Toggle to assign or unassign this skill from each agent.
      </p>
      <div className="divide-y divide-rule-2 overflow-hidden rounded-lg border border-rule-2 bg-canvas/30">
        {agents.map((agent) => {
          const assigned = assignedIds.has(agent.id);
          return (
            <label
              key={agent.id}
              className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={assigned}
                disabled={pending}
                onChange={() => toggle(agent.id)}
                className="h-4 w-4 shrink-0 accent-skill-vivid"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{agent.name}</span>
                <span className="block truncate font-mono text-[12px] text-ink-3">
                  {agent.slug}
                </span>
              </span>
              <span
                className={`shrink-0 text-[12px] font-medium ${assigned ? 'text-ok' : 'text-ink-4'}`}
              >
                {assigned ? 'Assigned' : 'Not assigned'}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
