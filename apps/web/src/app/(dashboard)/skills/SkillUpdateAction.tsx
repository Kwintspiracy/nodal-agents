'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { SkillUpdateDetail, CommunitySkillUpdatePreview } from '@/lib/actions.ts';
import {
  updateCommunitySkillAction,
  acknowledgeSkillUpdateAction,
  previewCommunitySkillUpdateAction,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import { diffLines, diffStats, collapseUnchanged } from '@/lib/line-diff.ts';

/**
 * The sentence above the diff. Says what will happen, and warns about the two
 * side effects a diff of SKILL.md cannot show: replaced local script edits, and
 * revoked script authorizations.
 *
 * The revocation warning is unconditional whenever the skill bundles any
 * scripts at all: applySkillUpdate recomputes the script diff at apply time
 * and can discover a script change the last background check didn't see.
 */
function describeChanges(detail: SkillUpdateDetail | null, hasScripts: boolean): string {
  // Three-way conflict: the local script files were edited AND upstream moved.
  // Applying replaces the local edits with upstream files. Say it plainly.
  const conflict =
    detail?.scriptsState === 'conflict'
      ? ' Your locally edited scripts will be replaced. Use "Keep your version" to keep them instead.'
      : '';
  const warning = hasScripts
    ? " Script changes revoke this skill's run authorization for every agent until you re-approve it."
    : '';
  return `This text goes into the system prompt of every agent using this skill.${conflict}${warning}`;
}

/**
 * SKILL-003: the actual text, not a category.
 *
 * This dialog used to say "Last check found: content changes" and install
 * whatever upstream held at click time — the owner approved text they had never
 * seen, from a third-party repo, straight into their agents' system prompts.
 */
function UpdateDiff({ preview }: { preview: CommunitySkillUpdatePreview }) {
  const lines = diffLines(preview.currentContent, preview.upstreamContent);
  const stats = diffStats(lines);
  const collapsed = collapseUnchanged(lines);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-body-12 text-ink-3">
        <span className="text-ok">+{stats.added}</span>
        <span className="text-err">−{stats.removed}</span>
        {preview.scriptsChanged && <span className="text-warn">bundled scripts changed</span>}
        {preview.contentOverridden && (
          <span>your local edits are kept — only the upstream baseline updates</span>
        )}
      </div>

      {stats.added === 0 && stats.removed === 0 ? (
        <p className="text-body-13 text-ink-3">
          The skill text is identical. {preview.scriptsChanged ? 'Only scripts changed.' : ''}
        </p>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-md bg-hover px-3 py-2 text-mono-12 leading-[1.5]! whitespace-pre">
          {collapsed.map((line, i) =>
            line === null ? (
              <div key={i} className="text-ink-4">
                {'  ⋯'}
              </div>
            ) : (
              <div
                key={i}
                className={
                  line.op === 'add'
                    ? 'bg-ok-bg text-ok'
                    : line.op === 'remove'
                      ? 'bg-warn-bg text-err'
                      : 'text-ink-3'
                }
              >
                {(line.op === 'add' ? '+ ' : line.op === 'remove' ? '− ' : '  ') + line.text}
              </div>
            ),
          )}
        </pre>
      )}

      {preview.scriptNames.length > 0 && (
        <p className="text-body-12 text-ink-4">
          Bundled scripts: {preview.scriptNames.join(', ')}. Their contents are not shown here —
          read them in the skill store before re-authorizing.
        </p>
      )}
    </div>
  );
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
  const [preview, setPreview] = useState<CommunitySkillUpdatePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [isPending, startTransition] = useTransition();

  /**
   * Fetch the real text FIRST, then open the dialog. The confirmation is not
   * meaningful without it, so a failure to fetch must not fall through to a
   * blind "Update?" prompt — it reports the error and opens nothing.
   */
  function openWithPreview() {
    setLoadingPreview(true);
    void previewCommunitySkillUpdateAction(slug).then((r) => {
      setLoadingPreview(false);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setPreview(r.data);
      setConfirmOpen(true);
    });
  }

  function performUpdate() {
    setConfirmOpen(false);
    const hash = preview?.upstreamContentHash;
    startTransition(async () => {
      // The hash pins this apply to the text just shown: the runner
      // re-downloads, and refuses if upstream moved in between.
      const r = await updateCommunitySkillAction(slug, hash);
      setPreview(null);
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
      {children({ onClick: openWithPreview, pending: isPending || loadingPreview })}
      <ConfirmDialog
        open={confirmOpen}
        title={`Update skill "${name}"?`}
        message={describeChanges(updateDetail, hasScripts)}
        confirmLabel="Install this version"
        destructive={updateDetail?.scriptsState === 'conflict'}
        extra={preview ? <UpdateDiff preview={preview} /> : null}
        onConfirm={performUpdate}
        onCancel={() => {
          setConfirmOpen(false);
          setPreview(null);
        }}
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
