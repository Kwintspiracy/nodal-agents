// shell-truth.ts — what REALLY happens to this agent's commands, in one sentence (#464).
//
// The "Run commands" section used to say "Commands ask for your approval by
// default." Under `destructive_gate` that was false: with no rule, an ordinary
// command runs without asking (run 06a949cb, 23/09). And under
// `fully_autonomous` it is the opposite of what the level's name suggests: full
// autonomy never covers the shell, only a rule on `run_command` does
// (packages/tools/src/execute.ts, the code-execution exception). The sentence is
// computed from the same three facts the engine reads, so it cannot drift from
// what the gate does.

import type { RootGrants } from '@nodal-agents/shared';

export function runCommandsTruth({
  rule,
  paused,
  autonomy,
}: {
  /** The agent's rule on `run_command`, if any. */
  rule: 'auto_approve' | 'require_approval' | 'block' | null;
  /** The workspace auto-run brake: an `auto_approve` rule is then dormant. */
  paused: boolean;
  /** `null`: the workspace level could not be read, and the sentence says so. */
  autonomy: RootGrants['autonomy'] | null;
}): string {
  if (rule === 'block') return 'This agent cannot run commands: a rule blocks them.';
  if (rule === 'auto_approve' && paused) {
    return 'Yolo is paused by the auto-run brake: every command asks for your approval.';
  }
  if (rule === 'auto_approve') {
    return 'Commands run without asking, except the kinds of action below set to Ask me or Never.';
  }
  if (rule === 'require_approval') return 'Every command asks for your approval.';
  if (autonomy === null) return 'How commands run depends on the workspace autonomy.';
  if (autonomy === 'destructive_gate') {
    return 'Ordinary commands run without asking: the workspace only gates risky actions. The kinds of action below follow their setting.';
  }
  if (autonomy === 'fully_autonomous') {
    return 'Every command asks for your approval. Full autonomy never covers the shell: only Yolo does.';
  }
  return 'Every command asks for your approval.';
}
