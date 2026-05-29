'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import Link from 'next/link';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import { assignSkillAction, unassignSkillAction } from '@/lib/actions.ts';
import MarketplaceCard from '@/components/ui/MarketplaceCard';
import MarketplaceCardActions from '@/components/ui/MarketplaceCardActions';
import Modal from '@/components/ui/Modal';

type Props = {
  skills: SkillRow[];
  agents: AgentRow[];
};

/**
 * SkillsLibraryGrid — grid of skill cards built on the MarketplaceCard
 * primitive. The Assign CTA opens a modal that lists workspace agents and lets
 * the user toggle assignment per-agent in place.
 */
export default function SkillsLibraryGrid({ skills, agents }: Props) {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {skills.map((s) => (
        <SkillCard key={s.id} skill={s} agents={agents} />
      ))}
    </div>
  );
}

function SkillCard({ skill, agents }: { skill: SkillRow; agents: AgentRow[] }) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <MarketplaceCard
        name={skill.name}
        description={skill.description ?? <span className="font-mono">{skill.slug}</span>}
        foot={
          <MarketplaceCardActions
            status={
              skill.assignmentCount > 0
                ? `Used by ${skill.assignmentCount} ${skill.assignmentCount === 1 ? 'agent' : 'agents'}`
                : 'Not assigned'
            }
            ctaLabel="Assign"
            ctaVariant="coral"
            onCta={() => setModalOpen(true)}
          />
        }
      />

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={`Assign "${skill.name}"`}>
        <AssignPanel skill={skill} agents={agents} onClose={() => setModalOpen(false)} />
      </Modal>
    </>
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
      <div className="py-6 text-center space-y-3">
        <p className="text-sm text-ink-3">No agents yet — create one first.</p>
        <Link
          href="/agents"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-400 hover:text-blue-300 underline underline-offset-2"
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
      <p className="text-xs text-ink-3 mb-3">
        Toggle to assign or unassign this skill from each agent.
      </p>
      <div className="divide-y divide-rule-2 overflow-hidden rounded-lg border border-rule-2 bg-canvas/30">
        {agents.map((agent) => {
          const assigned = assignedIds.has(agent.id);
          return (
            <label
              key={agent.id}
              className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-hover transition-colors"
            >
              <input
                type="checkbox"
                checked={assigned}
                disabled={pending}
                onChange={() => toggle(agent.id)}
                className="accent-skill-vivid w-4 h-4 shrink-0"
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-ink truncate">{agent.name}</span>
                <span className="block font-mono text-[11px] text-ink-3 truncate">
                  {agent.slug}
                </span>
              </span>
              <span
                className={`shrink-0 text-[11px] font-medium ${assigned ? 'text-ok' : 'text-ink-4'}`}
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
