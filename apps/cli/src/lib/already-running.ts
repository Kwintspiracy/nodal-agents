// already-running.ts — a running stack is not a pile of orphans.
//
// 2026-09-15, 21:05 local. Quentin's install was healthy on :3000 / :3001 /
// :25444. Someone ran `pnpm dev` in the repo; turbo's `nodal-agents:dev` task is
// `up`. The pre-flight found three live processes on the configured ports,
// printed "Cleaning up before starting…", and killed all three. The turbo run
// then failed on `@nodal-agents/web#dev`, so nothing replaced what had been
// killed, and the stack stayed down for two and a half hours (issue #117).
//
// `up` had no notion of ALREADY RUNNING. Its only two categories were "ours,
// therefore an orphan to clean up" and "a stranger, therefore refuse" — and the
// product itself, alive and answering, fell into the first one. That is the
// same mistake as #97 and #100 one more time: a process judged by WHERE it was
// found rather than by WHAT it is.
//
// An orphan is a process that outlived its launcher. A runner answering
// `/api/health` with 200, next to a `postmaster.pid` naming a live postmaster
// for our data directory, is not an orphan. It is the product. So `up` asks
// that question FIRST, before any cleanup at all, and when the answer is yes it
// refuses and stops — nothing signalled, nothing swept.
//
// The decision is a pure function. The probes it consumes cannot be run in a
// suite without a live stack, and the rule is the part worth holding still.

/** What the two probes found, with no interpretation. */
export interface RunningStackEvidence {
  /** True only when the runner answered `/api/health` with 200. */
  readonly runnerHealthy: boolean;
  /**
   * The postmaster our data directory claims, when it is not known to have
   * exited. Null when the lockfile is absent, foreign, or names a dead pid —
   * `livePostmasterPid` already applies the #98 rule, and this module does not
   * second-guess it.
   */
  readonly postmasterPid: number | null;
  /** The pid listening on the configured runner port, if any was measured. */
  readonly runnerPid: number | null;
  /** The pid listening on the configured web port, if any was measured. */
  readonly webPid: number | null;
}

export type StartVerdict =
  | { proceed: true }
  | { proceed: false; reason: 'ALREADY_RUNNING'; message: string };

/**
 * May `up` touch anything?
 *
 * BOTH proofs are required, and the conjunction is the whole rule.
 *
 * A healthy runner alone is not enough: the health endpoint is reached over a
 * port, and a port says nothing about which install answered. Another
 * Nodal-Agents on the same machine, or a stale tunnel, would then stop `up`
 * from ever recovering its own data directory.
 *
 * A live postmaster alone is not enough either: that is the ORPHAN case this
 * pre-flight was built for — a postmaster still holding the shared-memory
 * section after its launcher died. Refusing there would break the recovery
 * `up` has done correctly since 2026-08-20.
 *
 * Together they describe one thing only: a stack that is up and serving out of
 * this data directory. The right answer to that is to say so and stop.
 */
export function decideStart(evidence: RunningStackEvidence): StartVerdict {
  if (!evidence.runnerHealthy || evidence.postmasterPid === null) return { proceed: true };
  return {
    proceed: false,
    reason: 'ALREADY_RUNNING',
    message: formatAlreadyRunning(evidence),
  };
}

/**
 * What the user reads. It names the pids, because the next thing they will want
 * is to look at them — and because a refusal that cannot be checked is just an
 * obstruction.
 *
 * It also says exactly WHAT WAS OBSERVED rather than what we take it to mean.
 * The first wording ended on "so this is the product running, not leftovers to
 * clean up", and that is one reading of the evidence, not the evidence (review
 * pass 3 of #114). The two readings that produce this refusal are a 200 on the
 * configured runner port and a live postmaster for our data directory — and a
 * postmaster of ours orphaned from an earlier run, sitting next to somebody
 * else's server on that port, would produce them both. Refusing is still the
 * right move there, since `up` signals nothing either way. Telling the user
 * they are looking at their own running stack, when they may not be, is not:
 * they would go hunting for a window that does not exist.
 *
 * So the message states the two facts, and then says what to do when they do
 * not add up to "my stack is up".
 */
export function formatAlreadyRunning(evidence: RunningStackEvidence): string {
  const parts = [
    evidence.runnerPid === null ? null : `runner pid ${evidence.runnerPid}`,
    evidence.webPid === null ? null : `web pid ${evidence.webPid}`,
    `postgres pid ${String(evidence.postmasterPid)}`,
  ].filter((p): p is string => p !== null);
  const runnerRef = evidence.runnerPid === null ? 'that port' : `pid ${evidence.runnerPid}`;
  return (
    `Nodal-Agents looks already running (${parts.join(', ')}) — use \`nodal-agents down\` first.\n` +
    `  Nothing was stopped, and nothing was signalled.\n` +
    `  What was observed, and only that: something answered /api/health with 200 on the\n` +
    `  configured runner port, and postmaster.pid in our data directory names a live\n` +
    `  postmaster. That is usually this install, up and serving.\n` +
    `  If it is NOT yours: check ${runnerRef} to see whose server is on that port, free the\n` +
    `  port or change it in ~/.nodalai/config.json, then run \`up\` again.`
  );
}

/**
 * Take both readings and decide, in one call.
 *
 * Ordered so the CHEAP and CONCLUSIVE one comes first: the lockfile is a file
 * read, and when it names no live postmaster the answer is already "proceed" —
 * no HTTP request is made, and `up` on a machine with nothing running pays
 * nothing for this guard.
 */
export async function decideStartFromProbes(opts: {
  runnerPort: number;
  webPort: number;
  dataDir: string;
}): Promise<StartVerdict> {
  const { livePostmasterPid } = await import('./postgres.ts');
  const postmasterPid = livePostmasterPid(opts.dataDir);
  if (postmasterPid === null) return { proceed: true };

  const { probeRunnerHealth } = await import('./watchdog.ts');
  const health = await probeRunnerHealth(`http://127.0.0.1:${opts.runnerPort}`);
  if (health.state !== 'healthy') return { proceed: true };

  const { pidListeningOnPort } = await import('./ports.ts');
  return decideStart({
    runnerHealthy: true,
    postmasterPid,
    runnerPid: await pidListeningOnPort(opts.runnerPort),
    webPid: await pidListeningOnPort(opts.webPort),
  });
}

/**
 * The refusal, as an error so `index.ts` exits 1 through the path it already
 * has. Named so a caller can tell it from a genuine startup failure.
 */
export class AlreadyRunningError extends Error {
  readonly reason = 'ALREADY_RUNNING';
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyRunningError';
  }
}
