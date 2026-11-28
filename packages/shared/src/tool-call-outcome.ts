// tool-call-outcome.ts — what became of a tool call: one closed set, one reader.
//
// THE RULE (#1184, #1206). Every tool call ends with ONE outcome from the set
// below. The tool declares it (`ToolDefinition.outcomeOf`, or a thrown error),
// the seam that runs tools (`executeTool`, packages/tools/src/execute.ts) and
// the CLI runtimes' recorders write it ONCE, in `tool_calls.outcome`, beside
// what the call acted on (`tool_calls.target`). Every reader reads the column
// through the functions of this file, and nothing else decides whether a call
// worked: not a field of the output (`ok`, `isError`, `timedOut`), not the
// envelope the seam serializes into `tool_output`, not a marker in the
// transcript. An architecture test (`scanForOutcomeGuesses`,
// @nodal-agents/test-kit) refuses a production reader that parses an output
// to decide one.
//
// THE SET, named as the code already named these states:
//   - `done`: the call did what it was asked (a command that exited non-zero
//     ran: its exit status is data, `grep` returns 1);
//   - `failed`: it did not (a thrown error, a refused input, a returned
//     failure the tool declares, a command that timed out or could not start);
//   - `unknown`: it may or may not have taken effect (a request that was
//     transmitted and never answered, a run replaced while it was running, a
//     provider still working). Never retried blindly, never counted as done;
//   - `refused`: a rule of the owner, or a person, did not let it run;
//   - `awaiting_approval`: it waits on a person (an approval, a question).
//
// A row written before 0170 carries no outcome: `not_recorded`. Readers say so;
// nobody guesses it (migration 0170 typed, once, only what the seam had written
// explicitly).

import { CLAUDE_SHELL_TOOLS } from './cli-shell';
import { projectKey } from './project-key';

export const TOOL_CALL_OUTCOMES = [
  'done',
  'failed',
  'unknown',
  'refused',
  'awaiting_approval',
] as const;

export type ToolCallOutcome = (typeof TOOL_CALL_OUTCOMES)[number];

/** What a tool may declare of a result it RETURNED; the rest is the seam's. */
export type DeclaredToolOutcome = Extract<ToolCallOutcome, 'done' | 'failed' | 'unknown'>;

/** An outcome as a row records it: `not_recorded` for a row older than the column. */
export type RecordedOutcome = ToolCallOutcome | 'not_recorded';

/** Raised when a row carries a value outside the closed set (the CHECK of 0170 forbids it). */
export const TOOL_CALL_OUTCOME_OUT_OF_SET = 'TOOL_CALL_OUTCOME_OUT_OF_SET';

/** THE reader of `tool_calls.outcome`. */
export function readCallOutcome(value: string | null | undefined): RecordedOutcome {
  if (value === null || value === undefined) return 'not_recorded';
  if ((TOOL_CALL_OUTCOMES as readonly string[]).includes(value)) return value as ToolCallOutcome;
  // Invariant #4: a value the set does not know is a broken writer, said.
  throw new Error(`${TOOL_CALL_OUTCOME_OUT_OF_SET}: "${value}"`);
}

/**
 * May the call have changed something? A failed, refused or held call did not
 * do what it was asked; a done one did, an unknown one may have, and a row with
 * no outcome is said as such by its reader but counted, never dropped.
 */
export function callMayHaveActed(outcome: RecordedOutcome): boolean {
  return outcome !== 'failed' && outcome !== 'refused' && outcome !== 'awaiting_approval';
}

// ─── A CLI runtime's own calls ───────────────────────────────────────────────

/**
 * What became of a call a CLI session (Claude Code, Codex) made with its own
 * tools, from what its stream reports: `is_error` for Claude Code, an item's
 * `status: "failed"` for Codex. The shell rule is Nodal's own (`run_command`):
 * a command that RAN is `done` whatever its exit status, and these streams
 * flag a non-zero exit exactly as a command that could not run, so a shell
 * call's flag says nothing either way. What the stream cannot say is not
 * guessed from its text.
 */
export function cliCallOutcome(toolName: string, isError: boolean): ToolCallOutcome {
  if ((CLAUDE_SHELL_TOOLS as readonly string[]).includes(toolName)) return 'done';
  if (toolName === CODEX_SHELL_ITEM) return 'done';
  return isError ? 'failed' : 'done';
}

/** The item type of a Codex command run (`codex --json`). */
export const CODEX_SHELL_ITEM = 'command_execution';

// ─── What a call acted on ────────────────────────────────────────────────────

/**
 * The key of what a call acted on, as `tool_calls.target` keeps it. Three
 * forms, chosen by the seam in this order:
 *   - what the tool REPORTED while it ran (`ToolContext.reportTarget`): a send
 *     reports the chat it resolved, and the item it sent there;
 *   - the FILES the call named (its mutation targets of kind `file`): a folder
 *     bounds a call, it does not name what it changed;
 *   - otherwise the call itself: its tool and its arguments, hashed (a key, not
 *     a copy of the input: an input can carry what the audit masks). Computed
 *     by the seam (`callInputTarget`, @nodal-agents/tools), under the prefix
 *     below.
 */
export const INPUT_TARGET_PREFIX = 'input:';

export function chatTarget(channel: string, chatId: string): string {
  return `chat:${channel}:${chatId}`;
}

/** A thing sent to a chat (a file, an image, a voice note): the chat AND the thing. */
export function chatItemTarget(channel: string, chatId: string, item: string): string {
  return `${chatTarget(channel, chatId)} ${item}`;
}

/**
 * The files a call named, by the platform's identity of a path (`projectKey`:
 * one separator, a Windows path case-folded), so two tools that name the same
 * file in two spellings act on the same target.
 */
export function filesTarget(paths: readonly string[]): string | null {
  const unique = [...new Set(paths.map(projectKey))].sort();
  return unique.length === 0 ? null : unique.map((p) => `file:${p}`).join('\n');
}

// ─── The verdict of a job's calls ────────────────────────────────────────────

/** The columns of a `tool_calls` row this verdict reads. */
export interface OutcomeRow {
  readonly seq: number;
  readonly toolName: string;
  readonly toolCallId: string | null;
  readonly outcome: string | null;
  readonly target: string | null;
  readonly riskLevel: string | null;
  readonly readOnlyHint: boolean | null;
  /**
   * `false`: the gate refused the call before it ran (an invalid input, a
   * rule): it did nothing, the model read why, and it decides nothing here.
   */
  readonly executionStarted: boolean | null;
}

/**
 * Does the call only read? The tool's declared risk level says so, or an MCP
 * server's read-only hint. The same reading as the exchange record's (what it
 * cites, apps/runner/src/job/exchange-record.ts). A failed read changed
 * nothing: what the agent found, or did not, is in its answer.
 */
export function callOnlyReads(row: Pick<OutcomeRow, 'riskLevel' | 'readOnlyHint'>): boolean {
  return row.riskLevel === 'read' || row.readOnlyHint === true;
}

/** A call that failed, or whose effect is unknown, and that nothing later redid. */
export interface UnresolvedCall {
  readonly toolName: string;
  readonly toolCallId: string | null;
  readonly outcome: 'failed' | 'unknown';
  readonly target: string | null;
}

/**
 * The calls of a job that leave its work not done: every call that ran and
 * acts (`callOnlyReads` false) whose outcome is `failed` or `unknown`, unless
 * a LATER call (by `seq`, the order of writing) on the SAME target is `done`.
 * A later success of the same tool on another target resolves nothing: a
 * cover that was sent does not make up for the report that was not. A row
 * with no target is resolved by nothing. Rows without an outcome
 * (`not_recorded`) are neither failures nor successes: they decide nothing.
 *
 * `resolvedTargets`: what the platform itself carries out on a target when
 * the job completes (the harness sends a job's answer to the chat that asked,
 * apps/runner/src/job/answer-delivery.ts): a call on that very target is
 * made good by it.
 */
export function unresolvedCalls(
  rows: readonly OutcomeRow[],
  opts: { resolvedTargets?: readonly string[] } = {},
): UnresolvedCall[] {
  const madeGood = new Set(opts.resolvedTargets ?? []);
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const lastDoneSeq = new Map<string, number>();
  for (const row of ordered) {
    if (row.target !== null && readCallOutcome(row.outcome) === 'done') {
      lastDoneSeq.set(row.target, row.seq);
    }
  }
  const out: UnresolvedCall[] = [];
  for (const row of ordered) {
    const outcome = readCallOutcome(row.outcome);
    if (outcome !== 'failed' && outcome !== 'unknown') continue;
    if (callOnlyReads(row) || row.executionStarted === false) continue;
    if (row.target !== null && madeGood.has(row.target)) continue;
    const redone = row.target === null ? undefined : lastDoneSeq.get(row.target);
    if (redone !== undefined && redone > row.seq) continue;
    out.push({ toolName: row.toolName, toolCallId: row.toolCallId, outcome, target: row.target });
  }
  return out;
}

/**
 * The target as a person can read it in a line of the platform: a chat, a
 * file, or nothing for a key that is only a hash of the arguments.
 */
export function readableTarget(target: string | null): string | null {
  if (target === null || target.startsWith(INPUT_TARGET_PREFIX)) return null;
  return target.split('\n').join(', ');
}
