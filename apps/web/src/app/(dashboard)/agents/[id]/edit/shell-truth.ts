// shell-truth.ts — what REALLY happens to this agent's commands, in one sentence (#464).
//
// The "Run commands" section used to say "Commands ask for your approval by
// default." Under `destructive_gate` that was false: with no rule, an ordinary
// command ran without asking (run 06a949cb, 23/09). Since #917 there is no
// "no rule": `run_command` has a row like every tool, the gate applies it, and
// this sentence says it. The workspace autonomy level is not read here: it
// only gave the row its first value.

export function runCommandsTruth({
  rule,
  paused,
}: {
  /** The agent's row for `run_command`; `null` only when it is missing. */
  rule: 'auto_approve' | 'require_approval' | 'block' | null;
  /** The workspace auto-run brake: an `auto_approve` row is then dormant. */
  paused: boolean;
}): string {
  if (rule === null) return 'No setting: every command is refused until you choose one.';
  if (rule === 'block') return 'This agent cannot run commands.';
  if (rule === 'auto_approve' && paused) {
    return 'Run without asking is paused by the auto-run brake: every command asks for your approval.';
  }
  if (rule === 'auto_approve') {
    return 'Commands run without asking, except the kinds of action below set to Ask me or Never.';
  }
  return 'Every command asks for your approval.';
}

/**
 * The floor no setting lifts (#917): said where the tool is shown, so the
 * row never promises more than the gate gives (packages/tools/src/execute.ts,
 * the catastrophic-command floor).
 */
export const RUN_COMMAND_FLOOR =
  'A command that can wipe this machine (formatting a disk, a fork bomb) always asks, whatever this setting says.';
