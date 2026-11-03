'use client';

// AutonomyToolRow: one tool on the Approvals tab, as the OWNER reads it.
//
// Two texts, two readers (issue #382): `label` is the short imperative title,
// `summary` the sentence or two underneath. The tool's `description` is written
// for the MODEL and never reaches this component. It used to be what the row
// showed, and the owner got a wall of "do NOT" addressed to someone else.
//
// Its own file, and not a helper inside AgentComposer: a row is the smallest
// thing this screen promises, so it is the thing a component test renders.

import SegmentedControl from '@/components/ui/SegmentedControl';
import PrimaryButton from '@/components/ui/PrimaryButton';

export type AutonomyAction = 'auto_approve' | 'require_approval' | 'block';

/** The words of each value, the same on every row and on the approval card. */
export const AUTONOMY_LABEL: Readonly<Record<AutonomyAction, string>> = {
  auto_approve: 'Run without asking',
  require_approval: 'Ask for approval',
  block: 'Block',
};

/**
 * A row of this agent confined to one folder (#346): it applies there, the
 * tool's own row everywhere else (#917). Shown under the tool, never in its
 * place.
 */
export interface FolderRow {
  label: string;
  action: AutonomyAction;
  /** The folder's absolute path: what removing the row names. */
  workspacePath: string;
}

/**
 * What the agent can reach, in the vocabulary the connector operations already
 * use, so one row reads the same wherever it appears.
 */
const ACCESS_LABEL: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  destructive: 'Cannot be undone',
};

export default function AutonomyToolRow({
  slug,
  label,
  summary,
  risk,
  value,
  saving,
  onChange,
  lockedReason,
  folderRows = [],
  onRemoveFolder,
  note,
  hideUnset = false,
}: {
  /** The tool name. Stays visible: it is what the owner sees in a transcript. */
  slug: string;
  label: string;
  summary: string;
  risk: 'read' | 'write' | 'destructive';
  /**
   * The row's value. `null`: the agent has no row for this tool, and the gate
   * refuses it (#917). Said, never painted as a choice.
   */
  value: AutonomyAction | null;
  saving: boolean;
  onChange: (action: AutonomyAction) => void;
  /**
   * Set for a tool that may not be blocked (return_result). The row still
   * renders, because an owner who counts the built-in tools in the docs and
   * finds one fewer here would rightly wonder what is being hidden, but the control is
   * replaced by the reason. The server refuses the rule too; this is the
   * affordance, not the guard.
   */
  lockedReason?: string;
  /** The rows of this agent for this tool confined to one folder (#346, #361). */
  folderRows?: readonly FolderRow[];
  /** Removes one folder row; the tool's row then applies there too. */
  onRemoveFolder?: (workspacePath: string) => void;
  /** A line under the summary: what no setting changes (a floor of the gate). */
  note?: string;
  /**
   * A row that is a starting value, not a tool's own (a server's setting):
   * without a value it refuses nothing, so "Not set" is not said as a fault.
   */
  hideUnset?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      {/* Tool identity */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-medium-14 text-ink">{label}</span>
          <span
            className={[
              'inline-flex h-[18px] items-center rounded-full px-2 text-mono-11 uppercase tracking-[0.1em]',
              risk === 'destructive'
                ? 'bg-err/10 text-err'
                : risk === 'write'
                  ? 'bg-warn/10 text-warn'
                  : 'bg-hover text-ink-3',
            ].join(' ')}
          >
            {ACCESS_LABEL[risk] ?? risk}
          </span>
        </div>
        <p className="mt-0.5 text-body-13 leading-[1.4]! text-ink-3">{summary}</p>
        {note !== undefined && (
          <p className="mt-1 text-body-12 text-ink-4" data-testid={`autonomy-note-${slug}`}>
            {note}
          </p>
        )}
        <code className="mt-1 block text-mono-11 text-ink-4">{slug}</code>
        {folderRows.map((f) => (
          <p
            key={f.label}
            className="mt-1 flex flex-wrap items-center gap-2 text-body-12 text-ink-3"
            data-testid={`autonomy-folder-${slug}`}
          >
            <span>
              In {f.label}: {AUTONOMY_LABEL[f.action]}
            </span>
            {onRemoveFolder !== undefined && (
              <PrimaryButton
                variant="neutral"
                size="sm"
                onClick={() => onRemoveFolder(f.workspacePath)}
                disabled={saving}
                data-testid={`autonomy-folder-remove-${slug}`}
              >
                Remove
              </PrimaryButton>
            )}
          </p>
        ))}
        {value === null && !hideUnset && (
          <p className="mt-1 text-body-12 text-err" data-testid={`autonomy-unset-${slug}`}>
            Not set: this tool is refused until you choose.
          </p>
        )}
      </div>

      {lockedReason !== undefined ? (
        <div className="flex max-w-xs flex-col items-start gap-1 sm:items-end">
          <p
            className="text-body-12 leading-[1.4]! text-ink-4 sm:text-right"
            data-testid={`autonomy-locked-${slug}`}
          >
            {lockedReason}
          </p>
        </div>
      ) : (
        /* 3-way control: the tool's row, valid everywhere but the folders above */
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <SegmentedControl
            value={value}
            onChange={onChange}
            disabled={saving}
            ariaLabel={`Approval rule for ${label}`}
            options={[
              {
                value: 'auto_approve' as const,
                label: AUTONOMY_LABEL.auto_approve,
                activeClassName: 'bg-agent-vivid/15 text-agent-vivid border-agent-vivid/30',
                testId: `autonomy-btn-${slug}-auto_approve`,
              },
              {
                value: 'require_approval' as const,
                label: AUTONOMY_LABEL.require_approval,
                activeClassName: 'bg-warn/15 text-warn border-warn/30',
                testId: `autonomy-btn-${slug}-require_approval`,
              },
              {
                value: 'block' as const,
                label: AUTONOMY_LABEL.block,
                activeClassName: 'bg-err/15 text-err border-err/30',
                testId: `autonomy-btn-${slug}-block`,
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
