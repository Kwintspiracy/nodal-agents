'use client';

import { Fragment, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  PencilSimple,
  UserPlus,
  Trash,
  CloudX,
  ArrowClockwise,
  ShieldCheck,
} from '@phosphor-icons/react';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import type { SkillProvenanceSegment } from '@/lib/skill-provenance.ts';
import Table, { THead, Th, Tr, Td, TableSegmentRow } from '@/components/ui/Table';
import { deleteSkillAction, uninstallCommunitySkillAction } from '@/lib/actions.ts';
import AvatarStack from '@/components/ui/AvatarStack';
import CountPill from '@/components/ui/CountPill';
import StatusPill from '@/components/ui/StatusPill';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import Modal from '@/components/ui/Modal.tsx';
import AssignSkillModal from './AssignSkillModal.tsx';
import SkillForm from './SkillForm.tsx';
import SkillUpdateAction, { SkillKeepLocalAction } from './SkillUpdateAction.tsx';

type Props = {
  /** Ordered provenance segments (lib/skill-provenance.ts) — the Workspace
   *  view always renders the full segmented list. */
  segments: SkillProvenanceSegment<SkillRow>[];
  agents: AgentRow[];
};

/**
 * SkillsTable — the design's `.sk-tbl` pattern, used by the Workspace tab:
 * one row per installed skill (assigned or not, built-ins included), grouped
 * under provenance segment header rows (same dot+label grammar as the agent
 * composer's Skills tab), with name + from-hint, the agents it's assigned to
 * (avatar stack), required built-ins, status, and per-row actions
 * (Assign / Customise / Delete).
 *
 * Per-skill "Last used" + per-assignment customisation values from the design
 * mock aren't tracked in our DB — those columns are dropped per the
 * no-fake-data rule. `requiredBuiltins` IS a real array on the skill row, so it
 * gets surfaced as the customisation column.
 */
export default function SkillsAssignedTable({ segments, agents }: Props) {
  return (
    <Table>
      <THead>
        <Th>Skill</Th>
        <Th>Assigned to</Th>
        <Th>Required built-ins</Th>
        <Th align="right">Actions</Th>
      </THead>
      <tbody>
        {segments.map((seg) => (
          <Fragment key={seg.key}>
            <TableSegmentRow
              label={seg.label}
              count={seg.skills.length}
              dot={seg.dot}
              colSpan={4}
            />
            {seg.skills.map((s) => (
              <SkillTableRow key={s.id} skill={s} agents={agents} />
            ))}
          </Fragment>
        ))}
      </tbody>
    </Table>
  );
}

function SkillTableRow({ skill, agents }: { skill: SkillRow; agents: AgentRow[] }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uninstallConfirmOpen, setUninstallConfirmOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
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
    <Tr>
      <Td>
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-medium-13 leading-[1.2]! text-ink">{skill.name}</span>
              {/* Provenance is carried by the segment header row — no
                  per-row tag needed here. */}
              {skill.isCommunity && skill.updateAvailable && (
                <StatusPill variant="warn" label="Update available" />
              )}
            </div>
            <div
              className="mt-0.5 line-clamp-2 max-w-[460px] text-body-12 leading-[1.3]! text-ink-3"
              title={skill.description ?? skill.slug}
            >
              {skill.description ?? <span className="font-mono text-ink-4">{skill.slug}</span>}
            </div>
          </div>
        </div>
      </Td>

      <Td>
        {skill.assignmentCount > 0 ? (
          <AvatarStack avatars={skill.assignedAgents} max={4} label={`+${skill.assignmentCount}`} />
        ) : (
          <span className="text-mono-11 text-ink-4">Unassigned</span>
        )}
      </Td>

      <Td>
        {skill.requiredBuiltins.length > 0 ? (
          <CountPill items={skill.requiredBuiltins} noun="built-in" />
        ) : (
          <span className="text-mono-11 text-ink-4">none</span>
        )}
      </Td>

      <Td>
        <div className="flex items-center justify-end gap-2">
          {skill.isCommunity && skill.updateAvailable && (
            <SkillUpdateAction
              slug={skill.slug}
              name={skill.name}
              updateDetail={skill.updateDetail}
              hasScripts={Boolean(skill.installedScripts && skill.installedScripts.length > 0)}
            >
              {({ onClick, pending }) => (
                <RowActionButton
                  square
                  icon={<ArrowClockwise size={16} />}
                  title={
                    skill.updateDetail?.scriptsState === 'conflict'
                      ? 'Update available (replaces your edited scripts)'
                      : 'Update available'
                  }
                  disabled={pending}
                  onClick={onClick}
                />
              )}
            </SkillUpdateAction>
          )}
          {skill.isCommunity &&
            skill.updateAvailable &&
            skill.updateDetail?.scriptsState === 'conflict' && (
              <SkillKeepLocalAction slug={skill.slug} name={skill.name}>
                {({ onClick, pending }) => (
                  <RowActionButton
                    square
                    icon={<ShieldCheck size={16} />}
                    title="Keep your version"
                    disabled={pending}
                    onClick={onClick}
                  />
                )}
              </SkillKeepLocalAction>
            )}
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
            onClick={() => setEditOpen(true)}
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
        {/* Edit — non-dismissable Modal (UX-B6: editing a list object is
            always a modal, never a page navigation from the row). The
            dedicated /skills/[id]/edit route stays live for deep-links; both
            hosts render the same SkillForm. */}
        <Modal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          title={skill.name}
          dismissable={false}
          className="max-w-3xl"
        >
          <SkillForm mode="edit" initial={skill} onClose={() => setEditOpen(false)} />
        </Modal>
      </Td>
    </Tr>
  );
}
