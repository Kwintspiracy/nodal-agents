// running-version.ts — the Nodal-Agents version this process runs, as the
// launcher passed it (#454).
//
// The launcher (apps/cli/src/lib/env.ts) reads the installed package once and
// hands the SAME value to the runner and to the web, as NODAL_VERSION, or
// leaves it out when it could not read it. Every place that states the version
// reads it here: the runner's Runtime block (job/deployment.ts) and the
// dashboard screen that shows the ROOT's real prompt (web actions,
// getRootSystemPromptAction). A second reader drifted once already: the
// screen said "does not know" while the runner knew (Codex review of #454,
// pass 2).

/** The running version, or `undefined` when the launcher passed none. */
export function runningNodalVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const v = env['NODAL_VERSION']?.trim();
  return v ? v : undefined;
}
