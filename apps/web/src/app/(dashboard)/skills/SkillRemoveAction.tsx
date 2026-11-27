'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteSkillAction,
  previewSkillRemovalAction,
  type SkillRemovalChoice,
  type SkillRemovalPreview,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import SegmentedControl from '@/components/ui/SegmentedControl';

type RenderProps = { onClick: () => void; pending: boolean };

/**
 * The one removal of a skill from the Skills list. A community skill owns a
 * folder: before anything is removed, the dialog lists the files in it that
 * are the person's (added here, or shipped and changed here) and asks what
 * happens to them. "Keep my files" is selected first: a deletion cannot be
 * undone, and kept files are found and reviewed by the next install of the
 * same skill. Any other skill is only a row.
 */
export default function SkillRemoveAction({
  skill,
  children,
}: {
  skill: { id: string; slug: string; name: string; isCommunity: boolean };
  children: (props: RenderProps) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SkillRemovalPreview | null>(null);
  const [choice, setChoice] = useState<SkillRemovalChoice>('keep');
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();

  function openDialog() {
    if (!skill.isCommunity) {
      setOpen(true);
      return;
    }
    setLoading(true);
    void previewSkillRemovalAction(skill.slug).then((r) => {
      setLoading(false);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setPreview(r.data);
      setChoice('keep');
      setOpen(true);
    });
  }

  function perform() {
    setOpen(false);
    const hasOwn = (preview?.localFiles.length ?? 0) > 0;
    startTransition(async () => {
      const r = await deleteSkillAction(skill.id, hasOwn ? choice : undefined);
      setPreview(null);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(
        hasOwn && choice === 'keep'
          ? `Skill "${skill.name}" deleted. Your files are kept in the skill store.`
          : `Skill "${skill.name}" deleted`,
      );
    });
  }

  const own = preview?.localFiles ?? [];
  return (
    <>
      {children({ onClick: openDialog, pending: isPending || loading })}
      <ConfirmDialog
        open={open}
        title={`Delete skill "${skill.name}"?`}
        message="The skill and all its agent assignments will be removed. Existing job logs are kept."
        confirmLabel="Delete"
        extra={
          own.length > 0 ? (
            <div className="space-y-2" data-testid="skill-removal-own-files">
              <p className="text-medium-12 text-ink-2">
                {preview?.originKnown
                  ? `${own.length} file${own.length === 1 ? ' is' : 's are'} yours (added or changed here):`
                  : `Installed before file tracking: these ${own.length} files may come from the source or from you:`}
              </p>
              <ul className="max-h-32 overflow-auto text-mono-12 text-ink-3">
                {own.map((f) => (
                  <li key={f.path} className="break-all">
                    {f.path}
                  </li>
                ))}
              </ul>
              <SegmentedControl<SkillRemovalChoice>
                ariaLabel="What happens to your files"
                value={choice}
                onChange={setChoice}
                options={[
                  { value: 'keep', label: 'Keep my files' },
                  { value: 'delete', label: 'Delete them too' },
                ]}
              />
              {choice === 'keep' && (
                <p className="text-body-12 text-ink-4">
                  They stay in the skill store. Installing this skill again shows them for review.
                </p>
              )}
            </div>
          ) : null
        }
        onConfirm={perform}
        onCancel={() => {
          setOpen(false);
          setPreview(null);
        }}
      />
    </>
  );
}
