// code-task/sandbox.ts — what actually decides whether a coding CLI is confined.
//
// ## The finding, and the correction that followed
//
// First conclusion (2026-08-21): "`codex exec --sandbox` is not enforced on
// Windows". Reproduced five times, confirmed independently by an external
// review, and acted on — codex was refused outright on Windows.
//
// **That diagnosis was wrong.** The A/B that settled it — same directory, same
// command, one flag apart:
//
//     codex exec --json --sandbox read-only --skip-git-repo-check -
//     → PowerShell ran, the file was written
//
//     codex exec --json --sandbox read-only --skip-git-repo-check --ignore-user-config -
//     → "l'accès au système de fichiers est en lecture seule", nothing written
//
// The sandbox works on Windows. What made the two runs differ was the OWNER'S
// OWN `~/.codex/config.toml`, which every Nodal-spawned run was loading. Ruled
// out along the way: `trust_level = "trusted"` projects, since a directory
// outside every trusted project behaved identically.
//
// ⚠️ CORRECTION (2026-08-27). This paragraph used to name `[windows] sandbox =
// "elevated"` as the setting that "disabled" the sandbox. **That accusation was
// wrong**, and it cost a day: it made the missing setting look dangerous, so
// nobody put it back, and codex could not write ANYTHING through Nodal on
// Windows — neither `code_task` nor a runtime agent.
//
// Measured, four runs, same task, same directory, one variable at a time:
//
//   --sandbox workspace-write --ignore-user-config                        → no write
//   --sandbox workspace-write                          (config loaded)    → WROTE
//   --sandbox workspace-write --ignore-user-config -c approval_policy=…   → no write
//   --sandbox workspace-write --ignore-user-config -c windows.sandbox=…   → WROTE
//
// `elevated` names WHICH Windows confinement mechanism to use. Without it there
// is none, so the CLI refuses every write — the safe default, and an inert
// write mode. Two more runs proved it loosens nothing: read-only + elevated
// still refuses to write inside its own directory, and workspace-write +
// elevated still refuses to write outside it. `buildProviderArgs` therefore
// passes it on win32, and `code-task-sandbox.test.ts` pins both guards.
//
// So the real defect was never the platform. It was that **Nodal's confinement
// depended on a user configuration file Nodal did not control**: any setting in
// it could silently weaken the guarantee `code_task` prints on its approval
// card, on any OS, leaving no trace.
//
// That hole is closed at its source. `buildProviderArgs` now always passes
// `--ignore-user-config` (added for a separate leak — the same file was feeding
// the owner's personal MCP servers into Nodal runs — and it closes both). Auth
// still resolves from CODEX_HOME, so the subscription keeps working.
//
// ## Why there is no platform refusal here any more
//
// Refusing codex on Windows would now block a feature that works, for a reason
// that has been disproven. Leaving it in place "just in case" would be the exact
// failure `scripts/probe-codex-sandbox.mjs` was written to catch — a refusal
// outliving its reason — one commit after writing that probe.
//
// What replaces it is a measurement anyone can re-run:
//
//     node scripts/probe-codex-sandbox.mjs
//
// It attempts a real write with the shipped argv and reports whether the bytes
// landed. Run it after a codex upgrade, or on a platform nobody has measured.

import type { CodeTaskProvider, CodeTaskMode } from './providers';

/**
 * Is this provider confined here, with the arguments Nodal actually passes?
 *
 * Kept as the single place that answers the question, so a future measurement
 * has somewhere to land instead of scattered `if`s.
 *
 * Both providers qualify on every platform today, each for its own reason:
 *
 *   - **claude** removes the write tools from the model (`--disallowedTools`).
 *     Nothing to escape, so no OS support is involved.
 *   - **codex** relies on an OS sandbox, which does hold — measured on
 *     Windows — *provided the owner's config.toml is not loaded*.
 *     `buildProviderArgs` guarantees that with `--ignore-user-config`.
 *
 * If a platform is ever shown NOT to confine with the shipped argv, this is
 * where that becomes a refusal — with the reproduction in the comment, and this
 * time verified against the argv we ship rather than a hand-typed one.
 */
export function providerConfinementHolds(
  _provider: CodeTaskProvider,
  _platform: NodeJS.Platform,
): boolean {
  return true;
}

/**
 * Refuse a run whose confinement cannot be honoured, before anything is spawned.
 *
 * Called from `code_task`'s `preflight` — before an approval card exists. A
 * refusal that arrives after a human has approved is not a refusal; it is a
 * broken promise followed by an error message.
 *
 * Nothing refuses today. The seam stays because it is the valuable part: when a
 * measurement does turn up an unconfined combination, it plugs in here and lands
 * ahead of the approval, instead of being bolted onto `execute()` where the card
 * has already been shown — which is exactly the mistake the first version of
 * this fix made.
 */
export function assertSandboxEnforced(
  provider: CodeTaskProvider,
  _mode: CodeTaskMode,
  platform: NodeJS.Platform = process.platform,
): void {
  if (providerConfinementHolds(provider, platform)) return;

  throw new Error(
    `provider_not_confined: "${provider}" cannot be confined on ${platform} with the arguments ` +
      `Nodal passes, so the confinement stated on the approval card cannot be kept. ` +
      `Run \`node scripts/probe-codex-sandbox.mjs\` for the measurement.`,
  );
}
