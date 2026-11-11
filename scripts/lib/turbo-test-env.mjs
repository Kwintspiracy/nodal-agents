// turbo-test-env.mjs — what a `turbo run test` task must pass through so that a
// test can read the real Windows process table (issue #1056).
//
// turbo runs every task in strict environment mode: a task sees only the
// variables its `passThroughEnv` (or `env`, or the global lists) names, plus a
// handful turbo keeps on its own. `PSModulePath` and `PSModuleAnalysisCachePath`
// are not among them. Without either, the Windows PowerShell 5.1 the CLI spawns
// to read the process table (`apps/cli/src/lib/processes.ts`) rebuilds its
// module discovery over every module installed on the machine, and on GitHub's
// Windows image — hundreds of modules — `Get-CimInstance` and `Get-WmiObject`
// both pass their 20 s budget. Every test that needs the real table then skips.
//
// Measured, not supposed (CI Windows run 42995284264, idle runner, head
// 61a187cf2): with only the variables a turbo task keeps, the read timed out at
// 20 s; with PSModulePath alone restored it took 0.41 s, with
// PSModuleAnalysisCachePath alone 0.61 s; each of the 13 other dropped system
// variables, restored alone, still timed out. Outside turbo the same read takes
// 0.4 to 0.6 s (runs 42990753286, 42992085822).
//
// For a long time this looked like LOAD: the reads that succeeded in the
// `packages-2` shard did so just under the budget, more often when the shard was
// quiet. It is not the load; it is the environment.
//
// WHY ONLY THE CACHE PATH. Either variable alone is enough (measured above), and
// PSModulePath is kept out of the test workers on purpose:
// `packages/tools/src/tests/windows-env-derivation.test.ts` refuses it (#869),
// because the product drops it from the commands it starts, and a test of what
// a command sees must not see more on the host. The first version of this fix
// passed both, and that guard went red on CI Windows run 42997027295.
// PSModuleAnalysisCachePath is where the image keeps the module analysis it
// already did; passing it changes what PowerShell has to rediscover, not which
// modules it loads.
//
// The `test` task only, on purpose: nothing else run through turbo spawns
// PowerShell for the process table, and `scripts/verify-vc-runtime-signatures.mjs`
// (which drops PSModulePath itself, 169f1ec12) does not run through turbo.

/** What the `test` task must pass through, and why, in one place. */
export const REQUIRED_TEST_ENV = Object.freeze(['PSModuleAnalysisCachePath']);

/** The run that measured it. */
export const EVIDENCE_RUN = '42995284264';

/**
 * Does one `passThroughEnv` entry let `name` through? Windows variable names are
 * case-insensitive, and turbo accepts `*` wildcards and `!` exclusions.
 */
function patternMatches(pattern, name) {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    'i',
  );
  return re.test(name);
}

function passesThrough(entries, name) {
  let allowed = false;
  for (const entry of entries) {
    if (entry.startsWith('!')) {
      if (patternMatches(entry.slice(1), name)) return false;
    } else if (patternMatches(entry, name)) {
      allowed = true;
    }
  }
  return allowed;
}

/**
 * The required variables the `test` task of this turbo configuration does not
 * pass through. A configuration with no `test` task, or a `passThroughEnv` that
 * is not a list of strings, cannot be judged: it is refused, never waved
 * through (invariant #4).
 *
 * @param {unknown} turbo the parsed turbo.json
 * @returns {{ ok: true } | { ok: false, missing: string[], why: string }}
 */
export function checkTestTaskEnv(turbo) {
  const test = /** @type {any} */ (turbo)?.tasks?.test;
  if (test === undefined || test === null || typeof test !== 'object') {
    return { ok: false, missing: [...REQUIRED_TEST_ENV], why: 'turbo.json has no `tasks.test`' };
  }
  const entries = test.passThroughEnv ?? [];
  if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string')) {
    return {
      ok: false,
      missing: [...REQUIRED_TEST_ENV],
      why: '`tasks.test.passThroughEnv` is not a list of variable names',
    };
  }
  const missing = REQUIRED_TEST_ENV.filter((name) => !passesThrough(entries, name));
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, why: '`tasks.test.passThroughEnv` does not pass it through' };
}

/** The message a failing check prints: what is missing, what it costs, where it was measured. */
export function describeTestEnvFinding(result) {
  if (result.ok) return '';
  return (
    `turbo.json: the \`test\` task must pass through ${result.missing.join(' and ')} ` +
    `(${result.why}). Without it, Windows PowerShell 5.1 spawned by a test rebuilds its ` +
    `module discovery and the process-table read times out at 20 s, so every real-table ` +
    `test on CI Windows skips (CI Windows run ${EVIDENCE_RUN}, issue #1056).`
  );
}
