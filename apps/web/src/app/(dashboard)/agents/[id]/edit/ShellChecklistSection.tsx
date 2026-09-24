'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { setAgentShellPolicyAction } from '@/lib/actions.ts';
import SegmentedControl from '@/components/ui/SegmentedControl';
import {
  resolveShellPolicy,
  SHELL_CATEGORIES,
  type ShellCategory,
  type ShellCategoryState,
  type ShellPolicy,
} from '@nodal-agents/shared';
import { SHELL_CATEGORY_COPY } from '@/lib/shell-checklist-copy.ts';
import { SectionCard, SectionHead } from './SectionCard.tsx';

// ─── What an agent may NOT do with a shell (#464) ─────────────────────────────
//
// Run 06a949cb → b4b493e8 (23/09): an agent wrote a script and ran it on files
// in Downloads and Documents, folders it had never been given, and nobody was
// asked. The only fine control on this tab was a free-text list of programs,
// and Quentin: "even I would not know which command to write there". What a
// person CAN judge is what the agent must not do.
//
// So: one row per kind of action, each Allowed, Ask me or Never. The engine
// reads every command the agent runs against these rows, at every autonomy
// level and under Yolo too (`executeTool`, packages/tools/src/shell-checklist.ts).
// The list of programs stays, under Advanced, for people who know what to write.
//
// Shown even when the agent has no shell yet: like the allowlist, it is what
// an owner sets BEFORE handing one over.

const STATE_OPTIONS: Array<{
  value: ShellCategoryState;
  label: string;
  activeClassName: string;
}> = [
  {
    value: 'allow',
    label: 'Allowed',
    activeClassName: 'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30',
  },
  { value: 'ask', label: 'Ask me', activeClassName: 'bg-warn/15 text-warn border-warn/30' },
  { value: 'never', label: 'Never', activeClassName: 'bg-err/15 text-err border-err/30' },
];

export default function ShellChecklistSection({
  agentId,
  storedPolicy,
  isOwner,
}: {
  agentId: string;
  /** `agents.shell_policy` as stored: only what the owner set, NULL = nothing yet. */
  storedPolicy: unknown;
  isOwner: boolean;
}) {
  // Read once from what the server sent. A stored value the engine cannot
  // read is said, not repaired here: the job refuses to run on it too.
  const [initial] = useState<ShellPolicy | null>(() => {
    try {
      return resolveShellPolicy(storedPolicy);
    } catch {
      return null;
    }
  });
  const [policy, setPolicy] = useState<ShellPolicy | null>(initial);
  const [saving, setSaving] = useState<ShellCategory | null>(null);

  async function change(category: ShellCategory, state: ShellCategoryState) {
    if (!policy) return;
    const before = policy;
    setPolicy({ ...policy, [category]: state });
    setSaving(category);
    const result = await setAgentShellPolicyAction({ agentId, category, state });
    setSaving(null);
    if (!result.ok) {
      setPolicy(before);
      toast.error(result.message);
      return;
    }
    setPolicy(result.data);
  }

  return (
    <SectionCard>
      <SectionHead
        label="What it may do with a shell"
        // Honest about what a reading can promise (review of PR #474): Nodal
        // reads the command, not what a script does once it runs. Keeping an
        // agent inside its folders would take an OS sandbox.
        hint="Nodal reads each command, then runs it, asks you first, or refuses it, at every autonomy level. A script run from a file is not read: it can do any of these unseen."
      />
      {policy === null ? (
        <p className="text-body-13 text-err" data-testid="shell-checklist-unreadable">
          This agent’s setting cannot be read, so its runs stop before any command.
        </p>
      ) : (
        <div className="divide-y divide-rule rounded-lg border border-rule">
          {SHELL_CATEGORIES.map((category) => (
            <div
              key={category}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
              data-testid={`shell-row-${category}`}
            >
              <div className="min-w-0 flex-1">
                <span className="text-medium-14 text-ink">
                  {SHELL_CATEGORY_COPY[category].label}
                </span>
                <p className="mt-0.5 text-body-13 leading-[1.4]! text-ink-3">
                  {SHELL_CATEGORY_COPY[category].summary}
                </p>
              </div>
              <SegmentedControl
                value={policy[category]}
                onChange={(state) => void change(category, state)}
                disabled={!isOwner || saving !== null}
                ariaLabel={SHELL_CATEGORY_COPY[category].label}
                options={STATE_OPTIONS.map((o) => ({
                  ...o,
                  testId: `shell-btn-${category}-${o.value}`,
                }))}
              />
            </div>
          ))}
        </div>
      )}
      {!isOwner && (
        <p className="mt-2 text-body-12 text-ink-4">
          Only the workspace owner can change what an agent may do with a shell.
        </p>
      )}
    </SectionCard>
  );
}
