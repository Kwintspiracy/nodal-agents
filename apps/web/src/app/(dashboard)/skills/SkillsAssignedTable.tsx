'use client';

import { Fragment, useState } from 'react';
import { PencilSimple, UserPlus, Trash, ArrowClockwise, ShieldCheck } from '@phosphor-icons/react';
import type { SkillRow, AgentRow } from '@/lib/actions.ts';
import type { SkillProvenanceSegment } from '@/lib/skill-provenance.ts';
import Table, {
  THead,
  Th,
  Tr,
  Td,
  TableSegmentRow,
  CellTitle,
  CellMuted,
  CellActions,
} from '@/components/ui/Table';
import AvatarStack from '@/components/ui/AvatarStack';
import CountPill from '@/components/ui/CountPill';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import Modal from '@/components/ui/Modal.tsx';
import AssignSkillModal from './AssignSkillModal.tsx';
import SkillForm from './SkillForm.tsx';
import SkillUpdateAction, {
  SkillKeepLocalAction,
  hasFileConflict,
  toUpdatableSkill,
} from './SkillUpdateAction.tsx';
import SkillRemoveAction from './SkillRemoveAction.tsx';
import SkillSourceProblemPill from './SkillSourceProblemPill.tsx';

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
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  return (
    <Tr>
      <Td>
        {/* La provenance est portée par la ligne de segment : aucune étiquette
            par ligne ici. Sans description, le slug en tient lieu, à la
            recette `meta`. */}
        <CellTitle
          badge={
            // Whatever the origin: a community skill's source check and the
            // boot seeder (system skill the owner edited) raise the same flag.
            skill.updateDetail?.sourceProblem ? (
              <SkillSourceProblemPill detail={skill.updateDetail} />
            ) : skill.updateAvailable ? (
              <StatusPill variant="warn" label="Update available" />
            ) : undefined
          }
          description={skill.description ?? undefined}
          meta={skill.description ? undefined : skill.slug}
        >
          {skill.name}
        </CellTitle>
      </Td>

      <Td>
        {skill.assignmentCount > 0 ? (
          // Le libellé du composant Figma : « N agents », pas « +N » — la tuile
          // de débordement dit déjà « +N » (revue Reviewer C, PR #144).
          <AvatarStack
            avatars={skill.assignedAgents}
            max={4}
            label={`${skill.assignmentCount} ${skill.assignmentCount === 1 ? 'agent' : 'agents'}`}
          />
        ) : (
          <CellMuted>Unassigned</CellMuted>
        )}
      </Td>

      <Td>
        {skill.requiredBuiltins.length > 0 ? (
          <CountPill items={skill.requiredBuiltins} noun="built-in" />
        ) : (
          <CellMuted>none</CellMuted>
        )}
      </Td>

      <Td align="right">
        <CellActions>
          {skill.updateAvailable && (
            <SkillUpdateAction skill={toUpdatableSkill(skill)}>
              {({ onClick, pending }) => (
                <RowActionButton
                  square
                  icon={<ArrowClockwise size={16} />}
                  title={
                    hasFileConflict(skill.updateDetail)
                      ? 'Update available (replaces your edited scripts)'
                      : skill.contentOverridden
                        ? 'Update available (replaces your changes)'
                        : 'Update available'
                  }
                  disabled={pending}
                  onClick={onClick}
                />
              )}
            </SkillUpdateAction>
          )}
          {skill.updateAvailable && hasFileConflict(skill.updateDetail) && (
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
          {!skill.isSystem && (
            // One removal per skill: a community skill's folder goes with its
            // row, and the person chooses about their own files first.
            <SkillRemoveAction skill={skill}>
              {({ onClick, pending }) => (
                <RowActionButton
                  square
                  icon={<Trash size={16} />}
                  title="Delete"
                  tone="danger"
                  disabled={pending}
                  onClick={onClick}
                />
              )}
            </SkillRemoveAction>
          )}
        </CellActions>
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
