// outcome.ts — what a tool declares of a result it RETURNED (#1184).
//
// The seam (`executeTool`) writes one outcome per call, in the closed set of
// `@nodal-agents/shared` (`tool-call-outcome.ts`). A thrown error is `failed`
// (or `unknown` when it carries `mayHaveDelivered`); a returned result is
// `done`, unless the TOOL says otherwise through `ToolDefinition.outcomeOf`.
// The functions below are the declarations the product's tools share: each
// tool names the one that describes its own result. No reader applies them by
// convention, and none guesses: a tool that does not declare is `done`.

import { createHash } from 'node:crypto';
import {
  canonicalJson,
  cliCallOutcome,
  filesTarget,
  pathsDeclaredByCliWrite,
  INPUT_TARGET_PREFIX,
  type DeclaredToolOutcome,
  type ToolCallOutcome,
} from '@nodal-agents/shared';

/**
 * The result shape of the file, office, skill and meta tools: `{ ok: false,
 * reason | error }` when the tool refused or could not do what it was asked
 * (a path outside the workspaces, a missing `old_string`, an unknown agent).
 */
export function outcomeOfOkFlag(output: unknown): DeclaredToolOutcome {
  return output !== null && typeof output === 'object' && (output as { ok?: unknown }).ok === false
    ? 'failed'
    : 'done';
}

/**
 * A command (`run_command`, `run_skill_script`): one that ran is `done`
 * whatever its exit status (`grep` returns 1, `robocopy` 1 when it copied:
 * the status is data the model reads). One with no exit status did not run to
 * its end: killed at its timeout, stopped, or never started (`spawn_error`).
 */
export function outcomeOfCommand(output: { exitCode: number | null }): DeclaredToolOutcome {
  return output.exitCode === null ? 'failed' : 'done';
}

/**
 * The key of a call that names nothing else (`tool-call-outcome.ts`): its tool
 * and its arguments, hashed. `purpose` (the sentence for the approval card)
 * is left out, unless the tool declares it one of its own arguments.
 */
export function callInputTarget(
  toolName: string,
  input: unknown,
  tool: { readonly purposeIsArgument?: boolean } = {},
): string {
  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(input ?? null)) as unknown;
  } catch {
    plain = String(input);
  }
  if (!tool.purposeIsArgument && plain && typeof plain === 'object' && !Array.isArray(plain)) {
    const rest = { ...(plain as Record<string, unknown>) };
    delete rest['purpose'];
    plain = rest;
  }
  const digest = createHash('sha256').update(canonicalJson(plain)).digest('hex').slice(0, 24);
  return `${INPUT_TARGET_PREFIX}${toolName}:${digest}`;
}

/**
 * The outcome and target of a CLI session's own call (#1184): its outcome
 * from the stream's flag (`cliCallOutcome`), its target the files it names,
 * or the call itself. Shared by the CLI runtime's recorders
 * (apps/runner/src/cli-runtime/audit.ts) and by `code_task`'s (live-events.ts).
 */
export function cliCallVerdict(
  toolName: string,
  toolInput: unknown,
  isError: boolean,
): { outcome: ToolCallOutcome; target: string } {
  const prefixed = `cli:${toolName}`;
  return {
    outcome: cliCallOutcome(toolName, isError),
    target:
      filesTarget(pathsDeclaredByCliWrite(prefixed, toolInput).map((d) => d.path)) ??
      callInputTarget(prefixed, toolInput),
  };
}
