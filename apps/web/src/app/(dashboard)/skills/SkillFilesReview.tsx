'use client';

import type {
  SkillFileChange,
  SkillConflictChoice,
  SkillFileConflictReason,
} from '@/lib/actions.ts';
import SegmentedControl from '@/components/ui/SegmentedControl';

/**
 * What an update does to each file of the skill's folder — the same plan the
 * runner applies (skills/manifest.ts), file by file. A file the source never
 * shipped is kept and listed; a file changed both here and in the new version
 * is a conflict the owner decides before anything is written.
 */

const GROUPS: Array<{
  kinds: SkillFileChange['kind'][];
  title: string;
  tone: string;
}> = [
  { kinds: ['added'], title: 'New in this version', tone: 'text-ok' },
  { kinds: ['changed'], title: 'Changed in this version', tone: 'text-ink-2' },
  { kinds: ['removed'], title: 'Removed in this version', tone: 'text-err' },
  { kinds: ['kept-local-change'], title: 'Kept: your changes', tone: 'text-ink-3' },
  { kinds: ['kept-local-addition'], title: 'Kept: files added here', tone: 'text-ink-3' },
];

const REASON: Record<SkillFileConflictReason, string> = {
  'both-changed': 'Changed here and in the new version',
  'deleted-locally-changed-upstream': 'Deleted here, changed in the new version',
  'edited-locally-removed-upstream': 'Changed here, removed in the new version',
  'added-on-both-sides': 'Added here and in the new version',
  'unknown-origin': 'Installed before file tracking: your copy differs from the new version',
};

/** Every conflict has a choice: the only state in which the update may run. */
export function allConflictsChosen(
  files: SkillFileChange[],
  choices: Record<string, SkillConflictChoice>,
): boolean {
  return files.every((f) => f.kind !== 'conflict' || choices[f.path] !== undefined);
}

export default function SkillFilesReview({
  files,
  choices,
  onChoose,
}: {
  files: SkillFileChange[];
  choices: Record<string, SkillConflictChoice>;
  onChoose: (path: string, choice: SkillConflictChoice) => void;
}) {
  if (files.length === 0) return null;
  const conflicts = files.filter(
    (f): f is Extract<SkillFileChange, { kind: 'conflict' }> => f.kind === 'conflict',
  );

  return (
    <div className="space-y-3" data-testid="skill-files-review">
      {conflicts.length > 0 && (
        <div className="space-y-2">
          <p className="text-medium-12 text-warn">
            Choose for each file: keep yours, or take the new version
          </p>
          <ul className="space-y-2">
            {conflicts.map((f) => (
              <li key={f.path} className="space-y-1" data-testid={`skill-file-conflict-${f.path}`}>
                <div className="text-mono-12 text-ink-2 break-all">{f.path}</div>
                <div className="text-body-12 text-ink-4">{REASON[f.reason]}</div>
                <SegmentedControl<SkillConflictChoice>
                  ariaLabel={`Choice for ${f.path}`}
                  value={choices[f.path] ?? null}
                  onChange={(c) => onChoose(f.path, c)}
                  options={[
                    { value: 'keep-local', label: 'Keep mine' },
                    {
                      value: 'take-upstream',
                      label:
                        f.reason === 'edited-locally-removed-upstream' ? 'Remove it' : 'Take new',
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {GROUPS.map((g) => {
        const inGroup = files.filter((f) => g.kinds.includes(f.kind));
        if (inGroup.length === 0) return null;
        return (
          <div key={g.title} className="space-y-1">
            <p className={`text-medium-12 ${g.tone}`}>
              {g.title} ({inGroup.length})
            </p>
            <ul className="max-h-32 overflow-auto text-mono-12 text-ink-3">
              {inGroup.map((f) => (
                <li key={f.path} className="break-all">
                  {f.path}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
