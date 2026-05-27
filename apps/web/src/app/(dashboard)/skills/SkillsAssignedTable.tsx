'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DotsThree, PencilSimple, Star, Trash } from '@phosphor-icons/react';
import type { SkillRow } from '@/lib/actions.ts';
import { deleteSkillAction } from '@/lib/actions.ts';
import Disc from '@/components/ui/Disc';
import AvatarStack from '@/components/ui/AvatarStack';
import MonoCode from '@/components/ui/MonoCode';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

type Props = {
  skills: SkillRow[];
};

/**
 * SkillsAssignedTable — the design's `.sk-tbl` pattern: one row per
 * assigned skill, with disc + name + from-hint, assigned agents avatar
 * stack, customisation chips (from requiredBuiltins), a runs slot
 * (omitted until we track per-skill run counts), and per-row actions.
 *
 * Per-skill "Last used" + per-assignment customisation values from the
 * design mock aren't tracked in our DB — those columns are dropped per
 * the no-fake-data rule. `requiredBuiltins` IS a real array on the skill
 * row, so it gets surfaced as the customisation column.
 */
export default function SkillsAssignedTable({ skills }: Props) {
  return (
    <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
      <table className="w-full border-collapse">
        <thead>
          <Th label="Skill" />
          <Th label="Assigned to" />
          <Th label="Required built-ins" />
          <Th label="Status" />
          <Th label="Actions" align="right" />
        </thead>
        <tbody>
          {skills.map((s) => (
            <SkillRow key={s.id} skill={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return (
    <tr>
      <th
        className={`border-b border-rule-2 px-[18px] pt-3.5 pb-2.5 font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4 ${
          align === 'right' ? 'text-right' : 'text-left'
        }`}
        scope="col"
      >
        {label}
      </th>
    </tr>
  );
}

function SkillRow({ skill }: { skill: SkillRow }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const performDelete = () => {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteSkillAction(skill.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Skill deleted');
    });
  };

  return (
    <tr className="border-b border-rule-2 last:border-0 hover:bg-hover">
      <td className="px-[18px] py-4 align-middle">
        <div className="flex items-center gap-3">
          <Disc variant="skill" size="sm" shape="round">
            <Star size={14} weight="fill" />
          </Disc>
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium leading-[1.2] text-ink">{skill.name}</div>
            <div className="mt-0.5 text-[12px] leading-[1.3] text-ink-3">
              {skill.description ?? <span className="font-mono text-ink-4">{skill.slug}</span>}
            </div>
          </div>
        </div>
      </td>

      <td className="px-[18px] py-4 align-middle">
        <AvatarStack
          avatars={skill.assignedAgents}
          max={4}
          label={`${skill.assignmentCount} ${skill.assignmentCount === 1 ? 'agent' : 'agents'}`}
        />
      </td>

      <td className="px-[18px] py-4 align-middle">
        {skill.requiredBuiltins.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {skill.requiredBuiltins.slice(0, 4).map((b) => (
              <MonoCode key={b}>{b}</MonoCode>
            ))}
            {skill.requiredBuiltins.length > 4 && (
              <span className="font-mono text-[10.5px] text-ink-4">
                +{skill.requiredBuiltins.length - 4}
              </span>
            )}
          </div>
        ) : (
          <span className="font-mono text-[11px] text-ink-4">none</span>
        )}
      </td>

      <td className="px-[18px] py-4 align-middle">
        {skill.active ? (
          <span className="inline-flex items-center gap-1.5 font-sans text-[12.5px] text-ink-2">
            <span className="h-[7px] w-[7px] rounded-full bg-ok" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-sans text-[12.5px] text-ink-3">
            <span className="h-[7px] w-[7px] rounded-full bg-ink-4" />
            Inactive
          </span>
        )}
      </td>

      <td className="px-[18px] py-4 align-middle">
        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/skills/${skill.id}/edit`}
            className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-rule bg-paper px-3 text-[12px] font-medium leading-none text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            <PencilSimple size={13} />
            Customise
          </Link>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="More actions"
              className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-rule bg-paper text-ink-3 transition-colors hover:text-ink"
            >
              <DotsThree size={16} weight="bold" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute top-[calc(100%+4px)] right-0 z-20 min-w-[140px] rounded-[9px] border border-rule-2 bg-paper p-1 shadow-[0_12px_32px_rgba(0,0,0,0.10)]">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmOpen(true);
                    }}
                    disabled={isPending}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-err transition-colors hover:bg-warn-bg disabled:opacity-40"
                  >
                    <Trash size={13} />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <ConfirmDialog
          open={confirmOpen}
          title={`Delete skill "${skill.name}"?`}
          message="The skill and all its agent assignments will be removed. Existing job logs are kept."
          confirmLabel="Delete"
          onConfirm={performDelete}
          onCancel={() => setConfirmOpen(false)}
        />
      </td>
    </tr>
  );
}
