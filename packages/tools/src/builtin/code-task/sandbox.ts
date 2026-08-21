// code-task/sandbox.ts — where the coding CLIs' confinement actually holds,
// and where it only claims to.
//
// ## The finding (measured 2026-08-21, codex-cli 0.148.0, Windows 11)
//
// `code_task` tells the model, in its own input schema, that read mode means
// "the CLI cannot modify files or run shell commands", and that write mode
// edits "inside the workspace". For `provider: "codex"` on Windows, BOTH
// claims are false. Reproduced five times, including with the exact argv this
// package builds:
//
//     codex exec --json --sandbox read-only --skip-git-repo-check -c 'mcp_servers={}' -
//     → the CLI spawned powershell.exe, wrote the file, exit_code 0
//
//     codex exec --json --sandbox workspace-write --skip-git-repo-check -
//     → wrote a file OUTSIDE the working directory
//
// Also checked, so the cause is not one of these: it happens inside a real git
// repository as well as outside one; `-c 'sandbox_mode="read-only"'` (the only
// way to express a sandbox to `codex exec resume`, which takes no --sandbox
// flag) is accepted without error and equally ignored.
//
// The Windows restricted-token sandbox does exist inside codex — `codex sandbox`
// is a real subcommand and blocks writes — but it is internal (it demands
// `--sandbox-state-json`) and `codex exec` demonstrably does not apply it.
//
// ## Why this refuses instead of warning
//
// Three reasons, in order of weight:
//
//   1. **Consent.** Read mode is the DEFAULT, and the approval card presents it
//      as an analysis with no effect. A user who approved "analyse the repo"
//      must not receive writes. That is not a degraded guarantee, it is a
//      different action than the one they agreed to.
//   2. **No way to tell them in time.** `computeApproval` returns only
//      'require_approval' | undefined — a tool cannot add a caveat to the card
//      the human reads. Since the warning cannot reach the decision, the
//      decision must not be offered.
//   3. **The workspace contract.** `resolveAndCheckPath` and the workspace lock
//      exist to bound a run to one workspace. An unconfined write mode voids
//      that contract for every agent on the machine, not just this call.
//
// Claude is unaffected and stays available: its read mode removes the write
// tools from the model with `--disallowedTools` rather than sandboxing them, so
// there is nothing to escape.
//
// This is deliberately a platform check and not a probe. Probing would mean
// letting the CLI attempt a write to see whether it lands — on the user's
// machine, before every run.

import type { CodeTaskProvider, CodeTaskMode } from './providers';

/**
 * Does this platform actually enforce the sandbox `codex exec --sandbox` asks
 * for?
 *
 * Linux (seccomp/Landlock) and macOS (Seatbelt) are codex's supported sandbox
 * platforms and are treated as enforcing. Windows is not — measured, see the
 * header. Anything unknown is treated as NOT enforcing: an unverified platform
 * gets the safe answer, never the convenient one.
 */
export function codexSandboxEnforced(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}

/**
 * Refuse a run whose confinement we cannot honour, before anything is spawned.
 *
 * Throws with the reproduction and the alternative — a refusal that does not
 * say what to do instead just gets worked around.
 */
export function assertSandboxEnforced(
  provider: CodeTaskProvider,
  mode: CodeTaskMode,
  platform: NodeJS.Platform = process.platform,
): void {
  if (provider !== 'codex') return;
  if (codexSandboxEnforced(platform)) return;

  const claim =
    mode === 'read'
      ? 'read mode promises the CLI cannot modify files or run shell commands'
      : 'write mode promises edits stay inside the workspace';

  throw new Error(
    `codex_sandbox_unenforced: on ${platform}, \`codex exec --sandbox\` does not confine the ` +
      `CLI — measured 2026-08-21 with codex-cli 0.148.0: it spawned a shell and wrote files ` +
      `under --sandbox read-only, and wrote OUTSIDE the working directory under ` +
      `--sandbox workspace-write.\n\n` +
      `  This call is refused because ${claim}, and that promise cannot be kept here. ` +
      `The approval you would have seen states the promise, and a tool cannot add a caveat ` +
      `to it — so the choice is not offered rather than offered on false terms.\n\n` +
      `  Use \`provider: "claude"\` instead: its read mode removes the write tools from the ` +
      `model (--disallowedTools) rather than sandboxing them, so there is nothing to escape. ` +
      `codex remains available on Linux and macOS.`,
  );
}
