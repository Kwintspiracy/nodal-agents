'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { SkillUpdateDetail } from '@/lib/actions.ts';
import { updateCommunitySkillAction, acknowledgeSkillUpdateAction } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

/**
 * Turns updateDetail into the ConfirmDialog summary sentence. updateDetail is
 * a snapshot from the last background check — by the time the user clicks
 * Update, the upstream may have moved again (applySkillUpdate always
 * re-downloads and recomputes the real diff). So the copy leads with what the
 * action actually does, and only offers the last check's findings as a
 * hint, never as a promise of what will be installed.
 *
 * The revocation warning is unconditional whenever the skill bundles any
 * scripts at all: applySkillUpdate recomputes the script diff at apply time
 * and can discover a script change the last background check didn't see.
 */
function describeChanges(detail: SkillUpdateDetail | null, hasScripts: boolean): string {
  const found: string[] = [];
  if (detail?.contentChanged) found.push('content changes');
  if (detail?.scriptsChanged) found.push('script changes');
  const lastCheck = found.length > 0 ? ` Last check found: ${found.join(', ')}.` : '';
  // Three-way conflict: the local script files were edited AND upstream moved.
  // Applying replaces the local edits with upstream files. Say it plainly.
  const conflict =
    detail?.scriptsState === 'conflict'
      ? ' Your locally edited scripts will be replaced. Use "Keep your version" to keep them instead.'
      : '';
  const warning = hasScripts
    ? " Script changes revoke this skill's run authorization for every agent until you re-approve it."
    : '';
  return `This installs the latest upstream version.${lastCheck}${conflict}${warning}`;
}

type RenderProps = { onClick: () => void; pending: boolean };

type Props = {
  slug: string;
  name: string;
  updateDetail: SkillUpdateDetail | null;
  /** True when this skill bundles any scripts (installedScripts non-empty) —
   *  drives the unconditional revocation warning above. */
  hasScripts: boolean;
  /** Render-prop so each host (table row, marketplace card) composes its own
   *  button with the right shape — this component only owns the confirm +
   *  submit logic, shared so the copy and revocation toast can't drift
   *  between SkillsAssignedTable and CommunitySkillsGrid. */
  children: (props: RenderProps) => React.ReactNode;
};

export default function SkillUpdateAction({
  slug,
  name,
  updateDetail,
  hasScripts,
  children,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function performUpdate() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await updateCommunitySkillAction(slug);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const revoked = r.data.scriptsAuthorizationRevoked;
      if (revoked > 0) {
        toast.success(
          `"${name}" updated. Script authorization revoked for ${revoked} agent${revoked === 1 ? '' : 's'}, re-approve to keep running scripts.`,
        );
      } else {
        toast.success(`"${name}" updated.`);
      }
    });
  }

  return (
    <>
      {children({ onClick: () => setConfirmOpen(true), pending: isPending })}
      <ConfirmDialog
        open={confirmOpen}
        title={`Update skill "${name}"?`}
        message={describeChanges(updateDetail, hasScripts)}
        confirmLabel="Update"
        destructive={updateDetail?.scriptsState === 'conflict'}
        onConfirm={performUpdate}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

/**
 * « Keep your version » — resolves a script conflict WITHOUT touching local
 * files: the runner re-baselines the origin hashes to the current upstream,
 * the update flag clears, script authorizations stay. Only rendered by hosts
 * when updateDetail.scriptsState === 'conflict'. Same render-prop shape as
 * SkillUpdateAction so hosts compose their own button.
 */
export function SkillKeepLocalAction({
  slug,
  name,
  children,
}: {
  slug: string;
  name: string;
  children: (props: RenderProps) => React.ReactNode;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function performKeep() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await acknowledgeSkillUpdateAction(slug);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (r.data.contentChanged) {
        toast.success(`"${name}": your scripts are kept. A content update is still available.`);
      } else {
        toast.success(`"${name}": your scripts are kept.`);
      }
    });
  }

  return (
    <>
      {children({ onClick: () => setConfirmOpen(true), pending: isPending })}
      <ConfirmDialog
        open={confirmOpen}
        title={`Keep your version of "${name}"?`}
        message="Keeps your edited scripts exactly as they are and clears the update flag. It comes back only if upstream changes again. Script authorizations are untouched."
        confirmLabel="Keep mine"
        destructive={false}
        onConfirm={performKeep}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
