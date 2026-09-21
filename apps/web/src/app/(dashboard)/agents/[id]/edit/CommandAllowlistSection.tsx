'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { setAgentCommandAllowlistAction } from '@/lib/actions.ts';
import TextArea from '@/components/ui/TextArea';
import Checkbox from '@/components/ui/Checkbox';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { SectionCard, SectionHead } from './SectionCard.tsx';

// ─── Commands this agent may start (issue #131) ───────────────────────────────
//
// The product path for `agents.command_allowlist`, shipped engine-first by
// #122 and reachable from nothing until this screen existed: the only way to
// give an agent a list was a SQL UPDATE by hand.
//
// It sits next to the `command-execution` tool group and the Yolo toggle
// because the three are read together: the skill says the agent has a shell at
// all, Yolo says nobody reads the command before it runs, and this list says
// WHICH programs may start. The third is what makes the second defensible for
// a narrow job.
//
// Three states, said in words, because the difference between two of them is
// invisible in a text field:
//
//   NULL  no list, unrestricted, what every agent has today;
//   []    a decision, not an absence: every command is refused;
//   [...] only these programs start.
//
// Hence the checkbox. An emptied field saves NULL — the owner removed their
// list — and "Refuse every command" is the only way to save `[]`. Reading an
// empty field as "refuse everything" would turn a clearing gesture into a
// silent kill switch on the agent's work.
//
// What the action refuses is NOT re-implemented here (a shell on the list, a
// metacharacter in an entry): the message from `setAgentCommandAllowlistAction`
// is rendered as it comes, under the field. A second copy of those rules in the
// browser would be a second thing to keep true.

/**
 * One entry per line, trimmed, inner runs of spaces collapsed, blanks dropped,
 * and each entry kept once.
 *
 * The duplicate is dropped EXACTLY, never case-insensitively: the engine
 * compares an entry's arguments byte-exact on every platform (to npx, `vitest`
 * and `VITEST` are different packages), and only the leading program is
 * case-folded, and only on Windows. Folding here would tell the owner that two
 * entries are the same when the engine will not agree.
 */
export function parseAllowlistDraft(draft: string): string[] {
  const entries = draft
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0);
  return [...new Set(entries)];
}

/** What the owner is about to save: the checkbox wins, an empty field is NULL. */
export function draftToAllowlist(draft: string, refuseEvery: boolean): string[] | null {
  if (refuseEvery) return [];
  const entries = parseAllowlistDraft(draft);
  return entries.length === 0 ? null : entries;
}

/** The current state, in the words the owner reads. */
export function allowlistStateLine(allowlist: string[] | null): string {
  if (allowlist === null) {
    return 'No list: this agent may start any command (what every agent has today)';
  }
  if (allowlist.length === 0) {
    return 'Empty list: every command is refused';
  }
  const count = allowlist.length === 1 ? '1 entry' : `${allowlist.length} entries`;
  return `${count}: only these programs start, one per command, no shell`;
}

export default function CommandAllowlistSection({
  agentId,
  allowlist,
  hasCommandSkill,
  isOwner,
}: {
  agentId: string;
  /** The saved value. NULL = no list. */
  allowlist: string[] | null;
  /** Whether the `command-execution` tool group is on for this agent. */
  hasCommandSkill: boolean;
  isOwner: boolean;
}) {
  // Same gate shape as the CLI runtime mode control and the Yolo toggle: the
  // server action only refuses a non-owner outside local-trust, and the client
  // reads the mode from the CLI-set public env var.
  const isLocalTrust = (process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'local-trust') === 'local-trust';
  const canEdit = isLocalTrust || isOwner;

  const [saved, setSaved] = useState<string[] | null>(allowlist);
  const [draft, setDraft] = useState<string>((allowlist ?? []).join('\n'));
  const [refuseEvery, setRefuseEvery] = useState<boolean>(
    Array.isArray(allowlist) && allowlist.length === 0,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pending = draftToAllowlist(draft, refuseEvery);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const next = draftToAllowlist(draft, refuseEvery);
    const result = await setAgentCommandAllowlistAction({ agentId, allowlist: next });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(next);
    if (next !== null) setDraft(next.join('\n'));
    toast.success('Saved');
  }

  return (
    <SectionCard>
      <SectionHead label="Allowed commands" hint="Leave the list empty to allow any command." />

      <p className="text-body-13 text-ink" data-testid="command-allowlist-state">
        {allowlistStateLine(saved)}
      </p>

      <div className="mt-4">
        <TextArea
          label="One entry per line"
          rows={4}
          value={draft}
          placeholder={'node\nnpx vitest'}
          disabled={!canEdit || refuseEvery}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="command-allowlist-entries"
        />
        <p className="mt-1 text-body-12 text-ink-4">
          Add one command prefix per line, such as node or npx vitest. Each entry allows that
          program and its arguments. With a list, commands run without a shell: no chaining, no
          redirection. Clear the list and save to remove the limit.
        </p>
      </div>

      <div className="mt-3">
        <Checkbox
          label="Block all commands"
          checked={refuseEvery}
          disabled={!canEdit}
          onChange={(e) => setRefuseEvery(e.target.checked)}
          data-testid="command-allowlist-refuse-every"
        />
      </div>

      {error && (
        <p
          className="mt-3 text-body-12 text-err"
          role="alert"
          data-testid="command-allowlist-error"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <PrimaryButton
          variant="neutral"
          type="button"
          size="sm"
          disabled={!canEdit || saving}
          onClick={() => void handleSave()}
          data-testid="command-allowlist-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
        <span className="text-body-12 text-ink-4">{allowlistStateLine(pending)}</span>
      </div>

      <p className="mt-4 text-body-12 text-ink-4">
        This list applies only to run_command. Skill scripts, Code tasks, and verification commands
        are unaffected.
      </p>

      {!hasCommandSkill && (
        <p className="mt-2 text-body-12 text-ink-4">
          This agent has no command tool group yet, so it starts nothing today. The list applies as
          soon as you turn it on.
        </p>
      )}

      {!canEdit && (
        <p className="mt-2 text-body-12 text-ink-4">
          Only the workspace owner can change what an agent is allowed to run.
        </p>
      )}
    </SectionCard>
  );
}
