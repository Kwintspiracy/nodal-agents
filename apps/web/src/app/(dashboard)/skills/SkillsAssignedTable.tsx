'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { PencilSimple, UserPlus, Trash, CloudX } from '@phosphor-icons/react';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import { deleteSkillAction, uninstallCommunitySkillAction } from '@/lib/actions.ts';
import AvatarStack from '@/components/ui/AvatarStack';
import CountPill from '@/components/ui/CountPill';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import AssignSkillModal from './AssignSkillModal.tsx';

type Props = {
  skills: SkillRow[];
  agents: AgentRow[];
};

/**
 * SkillsTable — the design's `.sk-tbl` pattern, used by the "My skills" tab:
 * one row per skill the user authored (assigned or not), with name + from-hint,
 * the agents it's assigned to (avatar stack), required built-ins, status, and
 * per-row actions (Assign / Customise / Delete).
 *
 * Per-skill "Last used" + per-assignment customisation values from the design
 * mock aren't tracked in our DB — those columns are dropped per the
 * no-fake-data rule. `requiredBuiltins` IS a real array on the skill row, so it
 * gets surfaced as the customisation column.
 */
export default function SkillsAssignedTable({ skills, agents }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th label="Skill" />
              <Th label="Assigned to" />
              <Th label="Required built-ins" />
              <Th label="Actions" align="right" />
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <SkillTableRow key={s.id} skill={s} agents={agents} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return (
    <th
      className={`border-b border-rule-2 px-[18px] pt-3.5 pb-2.5 font-mono text-[9.5px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
      scope="col"
    >
      {label}
    </th>
  );
}

function SkillTableRow({ skill, agents }: { skill: SkillRow; agents: AgentRow[] }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uninstallConfirmOpen, setUninstallConfirmOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const performDelete = () => {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteSkillAction(skill.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Skill deleted');
    });
  };

  const performUninstall = () => {
    setUninstallConfirmOpen(false);
    startTransition(async () => {
      const r = await uninstallCommunitySkillAction(skill.slug);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Skill "${skill.name}" uninstalled`);
    });
  };

  return (
    <tr className="border-b border-rule-2 last:border-0 hover:bg-hover">
      <td className="px-[18px] py-4 align-middle">
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[13.5px] font-medium leading-[1.2] text-ink">{skill.name}</span>
              {skill.isCommunity && (
                <span className="shrink-0 rounded bg-skill-vivid/15 px-1.5 py-0.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-skill-vivid">
                  community
                </span>
              )}
            </div>
            <div
              className="mt-0.5 line-clamp-2 max-w-[460px] text-[12px] leading-[1.3] text-ink-3"
              title={skill.description ?? skill.slug}
            >
              {skill.description ?? <span className="font-mono text-ink-4">{skill.slug}</span>}
            </div>
          </div>
        </div>
      </td>

      <td className="px-[18px] py-4 align-middle">
        {skill.assignmentCount > 0 ? (
          <AvatarStack avatars={skill.assignedAgents} max={4} label={`+${skill.assignmentCount}`} />
        ) : (
          <span className="font-mono text-[11px] text-ink-4">Unassigned</span>
        )}
      </td>

      <td className="px-[18px] py-4 align-middle">
        {skill.requiredBuiltins.length > 0 ? (
          <CountPill items={skill.requiredBuiltins} noun="built-in" />
        ) : (
          <span className="font-mono text-[11px] text-ink-4">none</span>
        )}
      </td>

      <td className="px-[18px] py-4 align-middle">
        <div className="flex items-center justify-end gap-2">
          <RowActionButton
            square
            icon={<UserPlus size={16} />}
            title="Assign to agents"
            onClick={() => setAssignOpen(true)}
          />
          <RowActionButton
            square
            icon={<PencilSimple size={16} />}
            title="Edit"
            href={`/skills/${skill.id}/edit`}
          />
          {!skill.isSystem && skill.isCommunity && (
            <RowActionButton
              square
              icon={<CloudX size={16} />}
              title="Uninstall"
              tone="danger"
              disabled={isPending}
              onClick={() => setUninstallConfirmOpen(true)}
            />
          )}
          {!skill.isSystem && (
            <RowActionButton
              square
              icon={<Trash size={16} />}
              title="Delete"
              tone="danger"
              disabled={isPending}
              onClick={() => setConfirmOpen(true)}
            />
          )}
        </div>
        <ConfirmDialog
          open={confirmOpen}
          title={`Delete skill "${skill.name}"?`}
          message="The skill and all its agent assignments will be removed. Existing job logs are kept."
          confirmLabel="Delete"
          onConfirm={performDelete}
          onCancel={() => setConfirmOpen(false)}
        />
        <ConfirmDialog
          open={uninstallConfirmOpen}
          title={`Uninstall community skill "${skill.name}"?`}
          message="The skill and all its agent assignments will be removed. You can reinstall it at any time from the same source."
          confirmLabel="Uninstall"
          onConfirm={performUninstall}
          onCancel={() => setUninstallConfirmOpen(false)}
        />
        <AssignSkillModal
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          skill={skill}
          agents={agents}
        />
      </td>
    </tr>
  );
}
