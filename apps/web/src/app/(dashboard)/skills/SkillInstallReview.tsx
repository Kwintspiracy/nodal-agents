'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  installCommunitySkillAction,
  type CommunitySkillInstallResult,
  type SkillConflictChoice,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import SkillFilesReview, { allConflictsChosen } from './SkillFilesReview.tsx';

type Review = Extract<CommunitySkillInstallResult, { status: 'review' }>;

/**
 * The store already holds files for a skill being installed (kept by an
 * earlier removal, or left by an older version): the runner wrote nothing
 * and returned the same file plan an update shows. The person reads it,
 * chooses for each conflict, and the install runs pinned to what they read.
 */
export default function SkillInstallReview({
  review,
  onInstalled,
  onCancel,
}: {
  review: Review;
  onInstalled: (result: CommunitySkillInstallResult) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, SkillConflictChoice>>({});
  const [isPending, startTransition] = useTransition();

  function perform() {
    startTransition(async () => {
      const r = await installCommunitySkillAction(review.source, {
        expectedFilesHash: review.upstreamFilesHash,
        conflictChoices: choices,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`Skill "${r.data.name}" installed`);
      onInstalled(r.data);
    });
  }

  return (
    <ConfirmDialog
      open
      title={`Install "${review.name}"?`}
      message="Files for this skill are already in the skill store, owned by no installed skill. Review what the install does with each of them."
      confirmLabel={isPending ? 'Installing…' : 'Install'}
      destructive={Object.values(choices).includes('take-upstream')}
      confirmDisabled={isPending || !allConflictsChosen(review.files, choices)}
      extra={
        <SkillFilesReview
          files={review.files}
          choices={choices}
          onChoose={(path, c) => setChoices((prev) => ({ ...prev, [path]: c }))}
        />
      }
      onConfirm={perform}
      onCancel={onCancel}
    />
  );
}
