'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { SkillRow, SkillUpdateDetail, CommunitySkillUpdatePreview } from '@/lib/actions.ts';
import {
  updateCommunitySkillAction,
  acknowledgeSkillUpdateAction,
  previewCommunitySkillUpdateAction,
  resetSkillToDefaultAction,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import CopyButton from '@/components/ui/CopyButton';
import { diffLines, diffStats, collapseUnchanged } from '@/lib/line-diff.ts';

/**
 * What an update needs to know about the skill, whatever its origin. A newer
 * version is announced the same way for every skill (`update_available`):
 * the source check for a community skill, the boot seeder for a system skill
 * the owner edited. Only where the new text comes from differs, and that is
 * this component's business, not the host's.
 */
export type UpdatableSkill = {
  id: string;
  slug: string;
  name: string;
  /** Community: the new version is at the source (preview + hash-pinned apply
   *  on the runner). Otherwise it is the stored catalog text (default_content)
   *  and applying it is "Reset to default". */
  isCommunity: boolean;
  /** The owner edited the text: updating replaces their changes. */
  contentOverridden: boolean;
  /** The text in use today — shown to an owner who edited it, so they can
   *  copy it and redo their changes on the new version. */
  content: string;
  updateDetail: SkillUpdateDetail | null;
  /** True when this skill bundles any scripts (installedScripts non-empty) —
   *  drives the unconditional revocation warning. */
  hasScripts: boolean;
};

export function toUpdatableSkill(skill: SkillRow): UpdatableSkill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    isCommunity: skill.isCommunity,
    contentOverridden: skill.contentOverridden,
    content: skill.content,
    updateDetail: skill.updateDetail,
    hasScripts: Boolean(skill.installedScripts && skill.installedScripts.length > 0),
  };
}

/** The warning an owner who edited the skill reads before updating it. */
export const EDITED_SKILL_UPDATE_MESSAGE =
  'You edited this skill. Updating replaces your changes with the new version. Copy your text first to redo them.';

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

/**
 * The owner's current text, read-only, with a Copy button: updating replaces
 * it, and this is what they redo their changes from.
 */
function EditedSkillText({ content }: { content: string }) {
  return (
    <div className="space-y-2" data-testid="edited-skill-text">
      <div className="flex items-center justify-between gap-2">
        <span className="text-medium-12 text-ink-3">Your current text</span>
        <CopyButton value={content} successMessage="Your text is copied" />
      </div>
      <pre className="max-h-60 overflow-auto rounded-md bg-hover px-3 py-2 text-mono-12 leading-[1.5]! whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  );
}

type RenderProps = { onClick: () => void; pending: boolean };

type Props = {
  skill: UpdatableSkill;
  /** Called once the update is applied (the edit form closes on it). */
  onUpdated?: () => void;
  /** Render-prop so each host (table row, marketplace card, edit form)
   *  composes its own button with the right shape — this component only owns
   *  the confirm + submit logic, shared so the copy and revocation toast can't
   *  drift between hosts. */
  children: (props: RenderProps) => React.ReactNode;
};

export default function SkillUpdateAction({ skill, onUpdated, children }: Props) {
  const { slug, name, updateDetail, hasScripts } = skill;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<CommunitySkillUpdatePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [isPending, startTransition] = useTransition();

  /**
   * Community: fetch the real text FIRST, then open the dialog. The
   * confirmation is not meaningful without it, so a failure to fetch must not
   * fall through to a blind "Update?" prompt — it reports the error and opens
   * nothing. A system skill's new version is the catalog text shipped with
   * this install: nothing to fetch.
   */
  function openDialog() {
    if (!skill.isCommunity) {
      setConfirmOpen(true);
      return;
    }
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
    if (!skill.isCommunity) {
      startTransition(async () => {
        // A system skill's new version is its default_content, which the boot
        // seeder keeps on the catalog text: installing it IS the reset.
        const r = await resetSkillToDefaultAction(skill.id);
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        toast.success(`"${name}" updated.`);
        onUpdated?.();
      });
      return;
    }
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
      onUpdated?.();
    });
  }

  const edited = skill.contentOverridden;
  const communityMessage = skill.isCommunity ? describeChanges(updateDetail, hasScripts) : null;
  const message = edited
    ? [EDITED_SKILL_UPDATE_MESSAGE, communityMessage].filter(Boolean).join(' ')
    : (communityMessage ?? 'Installs the new version of this skill.');
  const extra =
    edited || preview ? (
      <div className="space-y-4">
        {edited && <EditedSkillText content={skill.content} />}
        {preview && <UpdateDiff preview={preview} />}
      </div>
    ) : null;

  return (
    <>
      {children({ onClick: openDialog, pending: isPending || loadingPreview })}
      <ConfirmDialog
        open={confirmOpen}
        title={edited ? 'Update this skill?' : `Update skill "${name}"?`}
        message={message}
        confirmLabel={edited ? 'Update' : 'Install this version'}
        destructive={edited || updateDetail?.scriptsState === 'conflict'}
        extra={extra}
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
