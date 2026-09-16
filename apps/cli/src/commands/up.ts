// up.ts — start everything: postgres, migrations, seed, runner, web, then open browser

import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, writeConfig, LOG_DIR, PG_DATA_DIR, type Config } from '../lib/config.ts';
import {
  startEmbeddedPostgres,
  runMigrations,
  stopOrphanPostgres,
  livePostmasterPid,
  postgresProcessesForDataDir,
  LEGACY_PG_PASSWORD,
} from '../lib/postgres.ts';
import { seedDefaultUserEntityAgent } from '../lib/seed.ts';
import {
  buildEnvForRunner,
  buildEnvForWeb,
  buildDatabaseUrl,
  resolveAuthMode,
} from '../lib/env.ts';
import { isPortBindable, findFreePort, pidListeningOnPort } from '../lib/ports.ts';
import { measuredPort } from '../lib/orphans.ts';
import { decideStartFromProbes, AlreadyRunningError } from '../lib/already-running.ts';
import {
  confirmRecordedPid,
  formatRefusal,
  unconfirmedIdentityNotice,
} from '../lib/pid-confirm.ts';
import { logLauncherEvent, LAUNCHER_LOG } from '../lib/launcher-log.ts';
import {
  spawnRunner,
  spawnWeb,
  waitForHealth,
  assertWebRenders,
  writePids,
  clearPids,
  readPids,
  recordServiceTree,
  sweepRecordedChildren,
  killProcessTree,
  killPidTree,
  recordedRoot,
  processSnapshotWin,
  type ProcessRecord,
  walkDescendants,
  isPidAlive,
  waitForPidDead,
  type SpawnResult,
} from '../lib/processes.ts';
import { createClient, assertMasterKeyRestorable } from '@nodal-agents/db';
import { startHealthWatchdog, probeRunnerHealth, type Watchdog } from '../lib/watchdog.ts';

async function killSilent(child: SpawnResult): Promise<void> {
  // Kill the whole process tree — see killProcessTree for the Windows
  // rationale (cmd.exe wrapper would otherwise leave node.exe orphaned and
  // the listener port held).
  await killProcessTree(child);
}

/**
 * Print the tail of a service's log file, or say plainly that there is nothing
 * to show. Called on the health-check failure path, where the log holds the
 * actual diagnosis and the timeout message holds none of it.
 *
 * Never throws: this runs while we are already failing, and a missing or
 * unreadable log must not replace the original error with a second one.
 */
function printLogTail(service: 'runner' | 'web' | string, lines: number): void {
  const logFile = join(LOG_DIR, `${service}.log`);
  try {
    if (!existsSync(logFile)) {
      console.error(chalk.gray(`\n  ${service}: no log at ${logFile}`));
      return;
    }
    const tail = readFileSync(logFile, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-lines);
    if (tail.length === 0) {
      console.error(chalk.gray(`\n  ${service}: log is empty (${logFile})`));
      return;
    }
    console.error(chalk.yellow(`\n  Last ${tail.length} lines of ${service}.log:`));
    for (const line of tail) console.error(chalk.gray(`    ${line}`));
    console.error(chalk.gray(`  Full log: ${logFile}`));
  } catch {
    console.error(chalk.gray(`\n  ${service}: could not read ${logFile}`));
  }
}

export interface RunUpOptions {
  /**
   * Use `next dev` (HMR) for the web app instead of `next start`.
   * Skips the prod build and rebuilds modules on the fly. Slower first
   * page load, far faster iteration loop. Off by default.
   */
  dev?: boolean;
  /**
   * Hand the terminal back once everything is healthy, leaving the services
   * running. `nodal-agents down` stops them, `nodal-agents logs` reads them.
   *
   * Without this, `up` is the whole product's lifetime: closing the terminal —
   * or logging out, or rebooting — takes down the runner, and with it every
   * schedule, the curator, and the community-skill update watch. Those crons
   * exist and are correct; they simply never got to run overnight.
   *
   * Not a service manager. It survives the terminal, not the reboot; the
   * machine's own supervisor (Task Scheduler, systemd, launchd) is still what
   * puts Nodal back after a restart, and it can call `up --detach` to do it.
   */
  detach?: boolean;
}

export async function runUp(opts: RunUpOptions = {}): Promise<void> {
  // ── 1. Load config (write a no-friction default if missing) ───────────────

  let config = readConfig();
  if (!config) {
    // First run with no config: skip the interactive terminal wizard entirely.
    // Write a sensible default (loopback → local-trust, no login, no LLM) and
    // let the BROWSER onboarding flow collect the model + create the first
    // agent. The runner boots keyless (seed-llm-key finds no LLM_* env and
    // simply skips), so the dashboard's onboarding is reached on first load.
    //
    // Power users who want LAN / email-auth / a pre-baked LLM key still run
    // `nodal-agents init` explicitly — that path is unchanged.
    console.log(chalk.cyan('  First run — opening the dashboard to finish setup…\n'));
    const defaultConfig: Config = {
      // No `llm` section: the browser onboarding sets it via createLlmKeyAction.
      ports: { web: 3000, runner: 3001, postgres: 25432 },
      workerSecret: randomBytes(32).toString('hex'),
      serverActionsKey: randomBytes(32).toString('base64'),
      // M-4: authSecret is minted here (distinct from workerSecret) rather
      // than left for readConfig()'s auto-mint, because this in-memory
      // `config` is used directly below without a re-read.
      authSecret: randomBytes(32).toString('base64'),
      // loopback derives auth: local-trust (no login/signup). Leave `auth`
      // unset so resolveAuthMode falls back to the loopback → local-trust map.
      bind: 'loopback',
    };
    writeConfig(defaultConfig);
    config = defaultConfig;
  }

  // Fail fast on a dangerous config combination (local-trust + LAN bind =
  // unauthenticated RCE surface) BEFORE starting Postgres or spawning any
  // process — resolveAuthMode throws; see apps/cli/src/lib/env.ts.
  resolveAuthMode(config);

  // ── 1.4 Is it ALREADY RUNNING? Asked before anything is touched ───────────
  //
  // On 2026-09-15 at 21:05 a `pnpm dev` in the repo ran this command against a
  // healthy install, and the pre-flight below classified the live runner, web
  // and postgres as orphans and killed all three. The turbo run then failed, so
  // nothing replaced them; the stack was down for two and a half hours
  // (issue #117).
  //
  // The pre-flight is not wrong about orphans — it is missing a category. So
  // the question is asked HERE, ahead of the recorded-children sweep, ahead of
  // the port probe, ahead of every kill: is the product already up out of this
  // data directory? When it is, nothing is signalled and nothing is swept.
  const startVerdict = await decideStartFromProbes({
    runnerPort: config.ports.runner,
    webPort: config.ports.web,
    dataDir: PG_DATA_DIR,
  });
  if (!startVerdict.proceed) {
    logLauncherEvent('refused-kill', `already-running runner=${config.ports.runner}`);
    throw new AlreadyRunningError(startVerdict.message);
  }

  // URLs are computed after the port-rotation guard below — config.ports may
  // change between here and there if the OS has reserved the configured port.

  // ── 1.5 Port-conflict pre-flight ──────────────────────────────────────────
  // Catch orphans from a previous crashed run BEFORE spawning anything.
  // Common cause on Windows: terminal was closed without Ctrl+C, leaving
  // web/runner alive. Without this, EADDRINUSE crashes web mid-startup,
  // triggers shutdown, and leaves the user staring at "Stopping Nodal-Agents…".

  // Sweep orphans automatically. If we detect any of our configured ports
  // are held, kill those PIDs and continue. The user shouldn't have to
  // copy-paste taskkill commands every time their terminal closes badly.
  // A PID holding one of our ports is NOT automatically ours.
  //
  // This swept every listener and killed it. On 2026-08-21 an unrelated dev
  // server sat on :3000; `up` called it an "orphan", killed it, and started
  // normally — destroying someone else's work to free a port we merely wanted.
  //
  // A process counts as ours only if we can show it: either it is a PID we
  // recorded ourselves in ~/.nodalai/pids/processes.json, or it descends from
  // one. Anything else is a stranger — we refuse to start and say so, which is
  // recoverable, instead of killing it, which is not.
  const known = readPids();

  // FIRST, sweep what the previous run recorded — before any port is probed.
  //
  // This is the only cleanup that survives a hard kill, and a hard kill is what
  // Ctrl+C actually is here. Under a .cmd launcher, cmd.exe answers Ctrl+C with
  // "Terminate batch job (Y/N)?" and then destroys the whole tree at once — our
  // CLI included, in the middle of its own shutdown handler. Verified live on
  // 2026-08-21: the terminal showed the prompt returning BEFORE the handler's
  // own "Stopping Nodal-Agents…" line, and the CLI process was simply gone,
  // leaving three web-side processes behind.
  //
  // No amount of care inside that handler helps — it does not get to finish.
  // What does survive is the tree recorded on disk while everything was
  // healthy, so recovery belongs on the NEXT start, reading that record.
  //
  // It also reaches what a port scan never will: the deepest Turbopack worker
  // listens on nothing, so it is invisible to the probe below and would
  // otherwise accumulate, one per interrupted session, until the next reboot.
  // Which postgres processes belong to THIS data dir. Asked ONCE, and asked
  // BEFORE the first kill of the boot rather than after it: the leftover sweep
  // below force-kills recorded pids, and until #100 it did so without ever
  // consulting ownership. A recorded pid recycled onto a foreign postmaster was
  // indistinguishable from our own straggler.
  const pgTable = await postgresProcessesForDataDir();
  const ownedPgPids = new Set<number>(pgTable.owned);

  const leftovers = await sweepRecordedChildren(known?.children ?? [], ownedPgPids);
  if (leftovers.length > 0) {
    console.log(
      chalk.gray(`  Cleaned up ${leftovers.length} process(es) left by the previous session`),
    );
  }

  // Ownership, for the port probe below. The recorded children count as ours:
  // after a hard kill their parents are gone, so a live descendant walk finds
  // nothing and a survivor holding :3000 would be misjudged a stranger — which
  // would make `up` refuse to start rather than recover, a worse outcome than
  // the orphan it replaced.
  const ourPids = new Set<number>(
    [known?.runner, known?.web].filter((p): p is number => typeof p === 'number' && p > 0),
  );
  for (const child of known?.children ?? []) ourPids.add(child.pid);

  // ONE snapshot, walked once per root — not one snapshot per root.
  //
  // This used to be `Promise.all(roots.map(descendantPidsWin))`, which spawns a
  // PowerShell per root. Harmless with two roots; adding the recorded children
  // above quietly took it to a dozen concurrent WMI enumerations, and on a
  // two-core machine they throttle each other into the ground. On Windows CI
  // every one of them timed out — first at 6s, then at 20s — and each timeout
  // returned an empty table, so the guard disabled itself while looking like a
  // machine with nothing to clean. Reading the table once is both faster and
  // more correct: every root is then judged against the same instant.
  const snapshot = await processSnapshotWin();
  for (const root of [...ourPids]) {
    for (const rec of walkDescendants(snapshot, root)) ourPids.add(rec.pid);
  }

  // A pid is attributed to a port only where a listener probe MEASURED it.
  // Until 2026-09-14 the data-dir probe stapled `config.ports.postgres` to
  // every pid it returned; the boot that killed another install's postmaster
  // printed thirteen lines claiming :25450 for processes listening elsewhere or
  // on nothing at all (issue #97).
  const listeners: Array<{ name: string; port: number; pid: number }> = [];
  for (const [name, port] of [
    ['web', config.ports.web],
    ['runner', config.ports.runner],
    ['postgres', config.ports.postgres],
  ] as const) {
    const pid = await pidListeningOnPort(port);
    if (pid !== null) listeners.push({ name, port, pid });
  }

  /**
   * Is this pid one of ours? ONE answer, from ONE place.
   *
   * It used to fall back to `livePostmasterPid()` whenever the process table
   * could not be read — a second, looser answer to the same question, and it
   * accepted pids the confirmed set had already refused (pass-4 finding R1).
   * `postgresProcessesForDataDir` now covers that case itself, so a refusal
   * cannot be walked around.
   */
  const isOurPostmasterPid = (pid: number): boolean => ownedPgPids.has(pid);

  const orphans: Array<{ name: string; port: number | null; pid: number }> = [];
  const strangers: Array<{ name: string; port: number; pid: number }> = [];
  for (const { name, port, pid } of listeners) {
    // Postgres is not in our pid file (pg_ctl owns the postmaster), so the
    // ownership test above cannot speak for it — the DATA DIR does. Holding
    // our configured port proves nothing: another install can sit there, and
    // killing it is exactly the incident of 2026-09-14.
    const ours = name === 'postgres' ? isOurPostmasterPid(pid) : ourPids.has(pid);
    if (ours) orphans.push({ name, port, pid });
    else strangers.push({ name, port, pid });
  }

  if (strangers.length > 0) {
    const lines = strangers
      .map((s) => `  - :${s.port} is held by pid ${s.pid}, which Nodal-Agents did not start`)
      .join('\n');
    throw new Error(
      `Port conflict with a process that is not ours:\n${lines}\n\n` +
        `  Nodal-Agents will not kill a process it did not start — it could be your own\n` +
        `  work. Stop it yourself, or change the port in ~/.nodalai/config.json.`,
    );
  }

  // Postgres gets a SECOND probe, by DATA DIR. A port scan only sees a process
  // holding a socket, and the orphan that actually hurts holds none: a
  // postmaster that died during startup, or is stuck mid-shutdown, has no
  // listener left but still owns the Win32 shared-memory section — which is
  // keyed to the data dir, not the port. `up` would then sail past this
  // pre-flight and fail further down with the opaque FATAL "pre-existing
  // shared memory block is still in use", which is precisely what happened on
  // a live machine on 2026-08-20 (rebooting did not clear it; the port scan
  // reported all ports free throughout).
  if (!orphans.some((o) => o.name === 'postgres')) {
    const pgPid = livePostmasterPid();
    if (pgPid !== null && isOurPostmasterPid(pgPid)) {
      orphans.push({ name: 'postgres', port: measuredPort(pgPid, listeners), pid: pgPid });
    } else if (pgPid !== null) {
      // The lockfile names a pid the confirmed set refused, and which has not
      // been seen to exit. Say so: the alternative is a boot that looks clean
      // while an orphan we declined to identify still holds the shared-memory
      // block.
      console.log(
        chalk.yellow(
          `  - postmaster.pid in ${PG_DATA_DIR} names pid ${pgPid}, which has not been seen\n` +
            `    to exit. Its identity could NOT be confirmed: its start time differs from\n` +
            `    the one recorded, or it does not run out of that directory, or at least\n` +
            `    one of those two could not be read. Nothing was stopped. If Postgres then\n` +
            `    fails to start, check that pid yourself (its executable, its start time,\n` +
            `    which cluster it serves) and stop it through its owner rather than killing\n` +
            `    the number.`,
        ),
      );
    }
  }

  // THIRD probe: ask the OS which postgres processes this install owns. It runs
  // whatever the two above found — see the note below the paragraph.
  //
  // Both probes above read state a crash can destroy — a listening socket, and
  // our own lockfile. Seen live on 2026-08-20: a postmaster alive with neither,
  // still holding the shared-memory block, so `up` sailed past this pre-flight
  // and died on the opaque FATAL while reporting no orphan at all. The process
  // table is the one thing that cannot be erased by whatever killed it.
  // Every CONFIRMED postgres pid joins the list, not just when the two probes
  // above came up empty. Guarding this on "no postgres orphan yet" meant that a
  // postmaster found by its port or its lockfile brought none of its workers
  // with it: a worker surviving the stop was then neither killed nor checked,
  // while "Orphans cleaned up" was printed because no port was left held
  // (pass-6 finding R2).
  for (const pid of ownedPgPids) {
    if (orphans.some((o) => o.pid === pid)) continue;
    orphans.push({ name: 'postgres', port: measuredPort(pid, listeners), pid });
  }

  if (orphans.length > 0) {
    console.log(
      chalk.yellow(
        `Found ${orphans.length} orphan process${orphans.length === 1 ? '' : 'es'} on configured ports:`,
      ),
    );
    for (const o of orphans) {
      console.log(
        chalk.gray(
          o.port === null
            ? `  - ${o.name} for our data dir (pid ${o.pid}, listening on none of our ports)`
            : `  - ${o.name} on :${o.port} (pid ${o.pid})`,
        ),
      );
    }
    console.log(chalk.yellow('Cleaning up before starting…'));

    // Postgres needs SPECIAL handling. Its Win32 shared-memory section is
    // keyed to the DATA DIR, not the port — so rotating to a neighbouring
    // port (section 1.6 below) while an orphan postmaster still lives does
    // NOT help: the new postgres reattaches the same SHM key and dies with
    // FATAL "pre-existing shared memory block is still in use". The only real
    // fix is to make the orphan actually exit (which releases the SHM):
    //   1. `pg_ctl stop -m fast` (graceful — releases SHM cleanly), then
    //   2. tree-kill as a fallback, then
    //   3. VERIFY the pid is dead. If it survives, abort loudly with an
    //      actionable message instead of rotating into the misleading FATAL.
    // EVERY postgres orphan, not just the first (finding C7). The report listed
    // them all, then `find` stopped one and the loop below skipped the rest by
    // name: a postmaster could stay alive while `up` announced "Orphans cleaned
    // up" and started a second server on the same data dir.
    const pgOrphans = orphans.filter((o) => o.name === 'postgres');
    // The graceful stop goes through the pid we DECIDED — `stopOrphanPostgres`
    // refuses when the lockfile names anything else, because `pg_ctl` would
    // signal that other pid instead of ours. When it refuses, or fails, the
    // loop below stops each pid itself; the shared-memory section is then left
    // to the postmaster's own exit, which is the risk we take knowingly rather
    // than signalling a process we did not identify.
    //
    // Ownership is re-read RIGHT HERE too, not just before the kills below
    // (pass-9 finding R1): the set was decided back at the port pre-flight, and
    // a postmaster that died in between can have left its pid to a stranger
    // whose number the stale lockfile still matches. `stopOrphanPostgres`
    // compares pids, not processes, so without this the graceful stop was the
    // one step no fresh confirmation covered.
    const postmasterPid = pgOrphans[0]?.pid;
    if (postmasterPid !== undefined) {
      const confirmedNow = new Set<number>((await postgresProcessesForDataDir()).owned);
      if (confirmedNow.has(postmasterPid)) await stopOrphanPostgres(postmasterPid);
    }
    // The set was decided BEFORE the graceful stop. A pid freed by that stop and
    // handed to a stranger would pass `isPidAlive` and take the SIGKILL below,
    // so ownership is asked again — and asked PER PID, immediately before each
    // one is signalled, not once for the whole loop. Waiting for one candidate
    // can take five seconds, and a pid can turn over in that time (pass-5
    // finding R2). The window cannot be closed entirely without holding an OS
    // handle; this shrinks it to the syscall.
    // Anything we declined to touch: the closing line must not claim it was
    // cleaned up (pass-7 finding R2).
    const leftAlone: number[] = [];
    /** Non-postgres pids we declined to signal, for the closing line below. */
    const unconfirmed: number[] = [];
    for (const pgOrphan of pgOrphans) {
      const stillOurs = new Set<number>((await postgresProcessesForDataDir()).owned);
      if (!stillOurs.has(pgOrphan.pid)) {
        // A pid drops out of the owned set by DYING, which is exactly what a
        // successful graceful stop does. Counting those as "left running" told
        // the user a dead process was still there (pass-8 finding R3 — claimed
        // fixed then, and it was not: the edit was lost and the commit message
        // said otherwise. Pass 9 caught the claim).
        if (!isPidAlive(pgOrphan.pid)) continue;
        leftAlone.push(pgOrphan.pid);
        console.log(
          chalk.yellow(
            `  - postgres pid ${pgOrphan.pid} is alive but can no longer be confirmed as ours; it was NOT stopped`,
          ),
        );
        continue;
      }
      if (isPidAlive(pgOrphan.pid)) {
        try {
          // Kill the postmaster DIRECTLY — NOT `taskkill /T`. Walking the
          // postgres backend tree with /T HANGS on Windows (proven live: it
          // timed out, leaving the orphan alive and `up` aborting on the throw
          // below). TerminateProcess on the postmaster pid is instant; its
          // backends detect the dead postmaster and self-exit, releasing the
          // SHM. `process.kill(pid,'SIGKILL')` is TerminateProcess on Windows
          // (same as `Stop-Process -Force`, which is what actually worked) and
          // SIGKILL on Unix.
          process.kill(pgOrphan.pid, 'SIGKILL');
        } catch {
          /* best-effort — already gone */
        }
        await waitForPidDead(pgOrphan.pid, 5000);
      }
      if (isPidAlive(pgOrphan.pid)) {
        const killCmd =
          process.platform === 'win32'
            ? `powershell Stop-Process -Id ${pgOrphan.pid} -Force`
            : `kill -9 ${pgOrphan.pid}`;
        throw new Error(
          `An orphaned Postgres (pid ${pgOrphan.pid}) is still running and holds the ` +
            `shared-memory block for the data dir. Rotating ports won't help — the SHM ` +
            `segment is keyed to the data dir, not the port.\n` +
            `  Fix: run \`nodal-agents down\`, then \`${killCmd}\`. If it persists, reboot ` +
            `to clear the orphan kernel object. No data is lost — pg-data is preserved.`,
        );
      }
    }

    // The non-postgres orphans. `name` here is the CONFIGURED PORT this pid was
    // found on — "runner", "web" — never what the pid actually is, and until
    // #100 nothing else was asked either. A pid recorded as our runner and
    // recycled onto somebody's Postgres passed `ourPids`, never met
    // `ownedPgPids`, and took a `taskkill /T` that emptied its whole tree.
    //
    // So each root is re-confirmed against a FRESH reading — recorded creation
    // tick and executable name, from `recordServiceTree` — immediately before
    // it is signalled, and the tree kill itself now refuses to walk through a
    // foreign Postgres (see `killPidTree`).
    //
    // Only where a process table EXISTS, which is Windows. Elsewhere there is
    // nothing to confirm against, and refusing every kill on a machine that was
    // never going to answer would break `up`'s own recovery to close a hole
    // that only bites where pids are recycled aggressively. The kill there is
    // the same one as before, with the same reach as before.
    const tableAvailable = process.platform === 'win32';
    const table = tableAvailable ? await processSnapshotWin() : new Map<number, ProcessRecord>();
    for (const o of orphans) {
      if (o.name === 'postgres') continue; // already handled above
      const live = table.get(o.pid);
      const verdict = !tableAvailable
        ? ({ killable: true } as const)
        : confirmRecordedPid({
            recorded: recordedRoot(known, o.pid),
            live:
              live === undefined
                ? undefined
                : { pid: live.pid, startedAt: live.startedAt, name: live.name ?? '' },
            tableRead: table.size > 0,
            ownedPostgresPids: ownedPgPids,
          });
      if (!verdict.killable) {
        if (verdict.code !== 'PID_GONE') {
          unconfirmed.push(o.pid);
          console.log(chalk.yellow(`  - ${o.name} pid ${o.pid} was NOT killed: ${verdict.detail}`));
          process.stderr.write(`${formatRefusal(verdict)}\n`);
        }
        continue;
      }
      try {
        if (process.platform === 'win32') {
          // The tree, but a JUDGED tree: `killPidTree` drops `/T` when it finds
          // a postgres in there that our data dir does not claim, and refuses
          // the root outright when the fresh reading disowns it.
          await killPidTree(o.pid, ownedPgPids, recordedRoot(known, o.pid));
        } else {
          // SAID, not implied: nothing here confirmed what this pid now is, and
          // it is about to be killed anyway. Same sentence as `down` prints in
          // the same situation — one wording for one fact.
          console.log(chalk.gray(`  - ${unconfirmedIdentityNotice(o.name, o.pid)}`));
          process.kill(o.pid, 'SIGKILL');
        }
      } catch {
        /* best-effort */
      }
    }

    // Wait for OS to release the port (TCP sockets stick in TIME_WAIT briefly).
    // Re-poll for up to 10s before giving up.
    const deadline = Date.now() + 10_000;
    let stillHeld: typeof orphans = [];
    while (Date.now() < deadline) {
      stillHeld = [];
      for (const o of orphans) {
        // Nothing to wait for when no port was ever measured for this pid.
        if (o.port === null) continue;
        const pid = await pidListeningOnPort(o.port);
        if (pid !== null) stillHeld.push({ ...o, pid });
      }
      if (stillHeld.length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (stillHeld.length > 0) {
      // Windows can leave a "ghost socket" bound to a dead pid — the process
      // is reaped but the TCP/IP driver hasn't released the port. Don't bail
      // here; the port-rotation guard below (section 1.6) will detect that
      // the port is unbindable and rotate to a free neighbour. The user gets
      // a working stack on a new port instead of a copy-paste taskkill chore.
      const list = stillHeld.map((o) => `${o.name}:${o.port}=${o.pid}`).join(', ');
      console.log(chalk.yellow(`Some ports still held (likely Windows ghost sockets): ${list}.`));
      // Both things can be true at once, and this branch used to swallow the
      // second one (pass-8 finding R3).
      const alsoLeft = [...leftAlone, ...unconfirmed];
      if (alsoLeft.length > 0) {
        console.log(
          chalk.yellow(`Also left running, unconfirmed as ours: ${alsoLeft.join(', ')}.`),
        );
      }
      console.log(chalk.gray('Will rotate to free neighbours below.\n'));
    } else if (leftAlone.length > 0 || unconfirmed.length > 0) {
      // "Orphans cleaned up" used to print here whatever we had declined to
      // touch, because the check was "no port still held" — and a surviving
      // worker holds no port (pass-7 finding R2). Say what was actually done.
      //
      // Since #100 the same applies to a NON-postgres recorded pid whose
      // identity a fresh reading could not confirm: it was not killed either,
      // and "Orphans cleaned up" must not cover it.
      if (leftAlone.length > 0) {
        console.log(
          chalk.yellow(
            `Ports are free, but ${leftAlone.length} postgres process(es) were left running ` +
              `(${leftAlone.join(', ')}): they could not be confirmed as ours.\n`,
          ),
        );
      }
      if (unconfirmed.length > 0) {
        console.log(
          chalk.yellow(
            `${unconfirmed.length} recorded process(es) were left running ` +
              `(${unconfirmed.join(', ')}): the pid no longer identifies what we started.\n`,
          ),
        );
      }
    } else {
      console.log(chalk.green('Orphans cleaned up.\n'));
    }
  }

  // ── 1.6 Port-reservation guard (Windows Hyper-V/WinNAT excluded ranges) ──
  // Even with no orphan, a port can be unbindable because the OS has
  // reserved it. listen() returns EACCES and we'd fail downstream with a
  // confusing "Postgres start failed". Probe each configured port; if it's
  // not bindable, rotate to a free one nearby and persist so the next boot
  // uses the working port directly.

  const portChanges: Array<{ name: 'web' | 'runner' | 'postgres'; from: number; to: number }> = [];
  for (const name of ['web', 'runner', 'postgres'] as const) {
    const configured = config.ports[name];
    if (await isPortBindable(configured)) continue;
    const next = await findFreePort(configured + 1);
    portChanges.push({ name, from: configured, to: next });
    config.ports[name] = next;
  }

  if (portChanges.length > 0) {
    console.log(chalk.yellow('Configured ports unavailable — rotating:'));
    for (const c of portChanges) {
      console.log(chalk.gray(`  - ${c.name}: ${c.from} → ${c.to}`));
    }
    writeConfig(config);
    console.log(chalk.gray('  Updated ~/.nodalai/config.json.\n'));
  }

  // Now that ports are finalised, derive the user-facing URLs.
  const webUrl = `http://localhost:${config.ports.web}`;
  // 127.0.0.1, not localhost: in loopback mode the runner binds IPv4 127.0.0.1
  // only (see buildEnvForRunner). On Windows `localhost` resolves to ::1 (IPv6)
  // first, so a health probe to http://localhost:<runner> hits an address the
  // runner never listens on → the check times out even though the runner is up.
  // The web is fine on localhost because Next.js binds 0.0.0.0 (incl. ::1).
  const runnerUrl = `http://127.0.0.1:${config.ports.runner}`;

  // ── 2. Start embedded Postgres ────────────────────────────────────────────

  // SECRET-003 (audit 2026-08-07). The embedded cluster used to be reachable on
  // a predictable port with `nodalai`/`nodalai` — the same on every install — so
  // any local process could read the whole database (transcripts, memory,
  // connector tokens) without touching the file ACLs that protect secrets.key.
  //
  // A cluster created before this field exists still carries the old password:
  // initdb sets it once, so the fix has to go through ALTER USER on a running
  // server. `pgPassword` is what we start WITH; `pendingRotation` is what we
  // move to once it is up.
  const pgPassword = config.postgresPassword ?? LEGACY_PG_PASSWORD;
  const pendingRotation = config.postgresPassword ? null : randomBytes(24).toString('base64url');

  const pgSpinner = ora('Starting embedded Postgres…').start();
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
  try {
    pg = await startEmbeddedPostgres(undefined, config.ports.postgres, pgPassword);
    pgSpinner.succeed(chalk.green(`Postgres ready on port ${config.ports.postgres}`));
  } catch (err) {
    pgSpinner.fail('Failed to start Postgres');
    throw err;
  }

  // ── 2b. Shutdown handlers — registered HERE, not at the end ───────────────
  // The moment Postgres is up there is something that must be torn down on
  // Ctrl+C, and from here to the ready message there is a lot of waiting:
  // migrations, seed, and above all the health wait, whose budget is FIVE
  // MINUTES. These handlers used to be registered after all of it, so a Ctrl+C
  // during that window killed the CLI and left the postmaster running — with
  // its shared-memory section attached to the data dir, which is what makes the
  // next `up` fail on FATAL "pre-existing shared memory block is still in use".
  // The one window that is genuinely impatient is therefore the one that had no
  // handler at all.
  let shuttingDown = false;
  const running: { runner: SpawnResult | null; web: SpawnResult | null } = {
    runner: null,
    web: null,
  };

  /** Tear down whatever is up, in reverse order of start. Idempotent. */
  const shutdown = async (cause = 'signal'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Written BEFORE the teardown, not after: a shutdown that hangs or is
    // itself killed must still have said why it started (issue #111, point 3).
    logLauncherEvent('shutdown', `cause=${cause}`);
    console.log('\n' + chalk.yellow('  Stopping Nodal-Agents…'));
    // Read the tree BEFORE killing: clearPids() wipes it at the end, and on
    // Ctrl+C the live parent/child links are already collapsing (see
    // recordServiceTree for the full account).
    const recorded = readPids()?.children ?? [];
    await Promise.allSettled(
      [running.runner, running.web].filter((c): c is SpawnResult => c !== null).map(killSilent),
    );
    // Whatever the tree walk could no longer reach — in dev that is the Next
    // server behind the `next dev` launcher, which outlives its own parent.
    const swept = await sweepRecordedChildren(recorded);
    if (swept.length > 0) {
      console.log(chalk.gray(`  Also stopped ${swept.length} background worker(s) they had left`));
    }
    // Graceful, always: pg.stop() runs `pg_ctl stop -m fast`, which releases the
    // Win32 shared-memory section. A hard kill here would leak it.
    await pg.stop();
    clearPids();
    console.log(chalk.green('  Stopped. Goodbye!'));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  let effectivePgPassword = pgPassword;
  if (pendingRotation) {
    // ORDER MATTERS: persist first, then ALTER, then revert on failure. The
    // reverse order leaves a window where the role has changed and nothing on
    // disk knows the new value — an install that cannot open its own database.
    // This way the worst case is a config naming a password the role does not
    // have yet, which the next boot simply retries.
    writeConfig({ ...config, postgresPassword: pendingRotation });
    const rotated = await pg.rotatePassword(pendingRotation);
    if (rotated) {
      effectivePgPassword = pendingRotation;
    } else {
      writeConfig({ ...config, postgresPassword: undefined });
      // Not fatal: the install keeps working on the legacy password and retries
      // next boot. Loud rather than silent (invariant #4) — a database still
      // reachable with a well-known password is something the owner should know.
      console.warn(
        chalk.yellow(
          '  Could not rotate the local Postgres password — still using the shipped default.\n' +
            '  Any other process on this machine can read the database. Retried on next start.',
        ),
      );
    }
  }

  const databaseUrl = buildDatabaseUrl(config.ports.postgres, effectivePgPassword);

  // ── 3. Apply Drizzle migrations ───────────────────────────────────────────

  const migrateSpinner = ora('Applying database migrations…').start();
  try {
    await runMigrations(databaseUrl, { patchVectorAsText: !pg.vectorAvailable });
    migrateSpinner.succeed(chalk.green('Migrations applied'));
  } catch (err) {
    migrateSpinner.fail('Migration failed');
    await pg.stop();
    throw err;
  }

  // ── 3.5 Master-key sanity check (I-6) ─────────────────────────────────────
  // Before anything touches encrypted rows: if ~/.nodalai/secrets.key is
  // missing but the DB already has credentials / LLM keys encrypted with it,
  // fail loud instead of letting the runner silently mint a replacement key
  // (which would make all of that data permanently undecryptable). Runs here
  // — earliest point where both the config dir and the DB are available —
  // and BEFORE the seed step below or the runner boot (migrateLlmKeysToEncrypted
  // also calls loadOrCreateMasterKey, but by then it'd be too late to warn).

  {
    const { db, close } = createClient(databaseUrl, { max: 1 });
    try {
      await assertMasterKeyRestorable(db);
    } catch (err) {
      await close();
      await pg.stop();
      throw err;
    }
    await close();
  }

  // ── 4. Seed default user + entity + agent (local-trust only) ─────────────
  // The LOCAL_USER / LOCAL_ENTITY pair is the single identity used in
  // local-trust mode (no auth). In local-auth or bearer-token modes the
  // user creates their own entity at signup; seeding the local pair here
  // would leave the env-derived LLM key attached to a phantom entity the
  // signed-up user never sees — which is exactly the "no LLM configured"
  // bug we fixed in v0.1.3+.

  const authMode = resolveAuthMode(config);
  if (authMode === 'local-trust') {
    const seedSpinner = ora('Seeding default user and agent…').start();
    try {
      const { db, close } = createClient(databaseUrl, { max: 5 });
      await seedDefaultUserEntityAgent(db, config.llm?.model ?? null);
      await close();
      seedSpinner.succeed(chalk.green('Seed complete'));
    } catch (err) {
      seedSpinner.fail('Seed failed');
      await pg.stop();
      throw err;
    }
  }

  // ── 5. Spawn runner ───────────────────────────────────────────────────────

  const runnerEnv = buildEnvForRunner(config, databaseUrl);
  const runnerSpinner = ora('Starting runner…').start();
  const runnerProcess = spawnRunner(runnerEnv, { detach: opts.detach });
  running.runner = runnerProcess;
  const runnerPid = runnerProcess.pid ?? 0;
  runnerSpinner.succeed(chalk.green(`Runner started (pid ${runnerPid})`));

  // ── 6. Spawn web ──────────────────────────────────────────────────────────

  const webEnv = buildEnvForWeb(config, databaseUrl);
  const webSpinnerLabel = opts.dev ? 'Starting web (dev — HMR)…' : 'Starting web…';
  const webSpinner = ora(webSpinnerLabel).start();
  const webProcess = spawnWeb(webEnv, { dev: opts.dev, detach: opts.detach });
  running.web = webProcess;
  const webPid = webProcess.pid ?? 0;
  webSpinner.succeed(chalk.green(`Web started (pid ${webPid})`));

  // Save PIDs for `nodal-agents down`
  writePids({ runner: runnerPid, web: webPid });

  // ── 7. Wait for health ────────────────────────────────────────────────────

  const healthSpinner = ora('Waiting for services to be healthy…').start();
  // First run on a CLEAN machine is heavy and slow, and this is where a too-tight
  // budget bites hardest: embedded-postgres fetches its ~70MB binary at runtime
  // (its postinstall may be blocked by npm script-approval), the runner loads a
  // large module graph (googleapis et al.) off a cold disk cache, and seeds 19
  // system skills — all before it answers /api/health. On a warm machine this is
  // quick (<20s); on a fresh install it routinely blows past a minute, which is
  // exactly what tore the stack down for fresh installers (runner "did not become
  // healthy within 60000ms"). `next dev`/`next start` first-compile is similarly
  // slow from a cold cache. So the cold-start budget is generous — 5 minutes —
  // and env-overridable for very slow disks/connections.
  const webHealthMs = Number(process.env['NODALAI_WEB_HEALTH_MS']) || 300_000;
  const runnerHealthMs = Number(process.env['NODALAI_RUNNER_HEALTH_MS']) || 300_000;

  // A five-minute budget behind a spinner that only ever says "Waiting for
  // services to be healthy…" is indistinguishable from a hang, and it hides the
  // one fact that identifies the fault: WHICH service never answered. Track
  // each one, name what is still outstanding, and count the seconds.
  const pending = new Set(['runner', 'web']);
  const startedAt = Date.now();
  const describeWait = (): string => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const budget = Math.round(Math.max(runnerHealthMs, webHealthMs) / 1000);
    return `Waiting for ${[...pending].join(' + ')} — ${secs}s of ${budget}s`;
  };
  const ticker = setInterval(() => {
    healthSpinner.text = describeWait();
  }, 1000);
  // A stray interval would keep the event loop alive and hold the terminal
  // after everything else is done.
  ticker.unref?.();

  try {
    await Promise.all([
      waitForHealth(runnerUrl, runnerHealthMs).then(() => {
        pending.delete('runner');
      }),
      waitForHealth(webUrl, webHealthMs).then(() => {
        pending.delete('web');
      }),
    ]);
    // /api/health alone is NOT proof the dashboard renders — see
    // assertWebRenders' doc (0.7.8 ritual: every page 500'd on a missing
    // standalone dependency while both health endpoints stayed green).
    // Same generous budget as the health wait above — dev's first Turbopack
    // compile of `/` can take minutes on a cold cache (see assertWebRenders).
    pending.add('web page render');
    healthSpinner.text = describeWait();
    await assertWebRenders(webUrl, webHealthMs);
    pending.delete('web page render');
    clearInterval(ticker);
    healthSpinner.succeed(chalk.green('All services healthy'));

    // Everything is up and the process tree is fully formed — the only moment
    // where it can be read reliably. Ctrl+C tears the links down faster than a
    // shutdown handler can walk them (see recordServiceTree).
    await recordServiceTree({ runner: runnerPid, web: webPid });
  } catch (err) {
    clearInterval(ticker);
    healthSpinner.fail(
      `Health check timed out — still waiting for ${[...pending].join(' + ')} after ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    // The answer is almost always in the failing service's own log, and until
    // now the user was never told it existed. On 2026-08-20 the log said
    // "TypeError: Cannot read properties of undefined (reading 'validationLevel')"
    // — the exact root cause — while the CLI only reported a timeout, sending
    // the diagnosis off after Postgres instead.
    for (const svc of pending) {
      const name = svc === 'web page render' ? 'web' : svc;
      printLogTail(name, 20);
    }
    // IMPORTANT: tree-kill BOTH children (and await) so no orphan node.exe
    // survives to hold the port. Skipping this is what causes the next
    // `nodal-agents up` to fail at health check: the new runner can't bind on
    // :3001 because the old one is still alive behind a dead cmd.exe parent.
    await Promise.allSettled([killSilent(runnerProcess), killSilent(webProcess)]);
    await pg.stop();
    clearPids();
    // The first run on a fresh machine is slow (Postgres binary fetched at
    // runtime, a large module graph loaded off a cold disk cache). A retry runs
    // warm — binary cached, modules loaded — and usually comes up fast.
    console.error(
      chalk.yellow(
        '\n  First run on a fresh machine can take a while to warm up.\n' +
          '  → Run `nodal-agents up` again — it starts much faster the second time.\n' +
          '  → Still timing out after a retry? Raise the budget: set NODALAI_RUNNER_HEALTH_MS=600000\n',
      ),
    );
    throw err;
  }

  // ── 7.5 Non-blocking version notice ──────────────────────────────────────
  // Fire-and-forget: if a newer version is available, print one informational
  // line. Must never delay the ready message or throw — all errors are swallowed.
  // The race against a short timer ensures this can't stall the output.
  void (async () => {
    try {
      const { getInstalledVersion, getLatestVersion, isNewerVersion } =
        await import('../lib/version.ts');
      const installed = getInstalledVersion();
      // Timeout already capped inside getLatestVersion() at 5 s; we add an
      // outer race of 3 s here so any internal delay can't push the notice
      // after the ready block.
      const latest = await Promise.race([
        getLatestVersion(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ]);
      // Strictly newer only — a `!==` check also fires (and would send the
      // user toward `update`, i.e. a downgrade) when `latest` is OLDER, e.g. a
      // lagging registry mirror.
      if (latest !== null && isNewerVersion(latest, installed)) {
        console.log(chalk.cyan(`  ℹ v${latest} available — run \`nodal-agents update\``));
      }
    } catch {
      /* completely silent — version notice must never disrupt startup */
    }
  })();

  // ── 8. Open browser ───────────────────────────────────────────────────────
  // NODALAI_NO_BROWSER=1 disables this — set it on headless servers / CI
  // runners with no desktop, where `open` would either hang or crash.
  if (!process.env['NODALAI_NO_BROWSER']) {
    try {
      await open(webUrl);
    } catch {
      /* best-effort — headless environments without xdg-open shouldn't crash up */
    }
  }

  // ── 9. Ready message ──────────────────────────────────────────────────────

  console.log('');
  logLauncherEvent(
    'started',
    `web=${webUrl} runner=${runnerUrl} mode=${opts.detach ? 'detached' : 'foreground'}`,
  );
  console.log(chalk.bold.green(`  Nodal-Agents ready at ${webUrl}`));
  if (config.bind === 'lan') {
    console.log(chalk.cyan(`  LAN mode — sign up at ${webUrl}/login`));
  }

  // ── 9b. Detached: hand the terminal back and leave everything running ─────
  // The order matters. We return only AFTER the health + render checks above,
  // so a detached start that comes back to the prompt is a start that WORKED —
  // the failure path further up already tore the children down and threw.
  //
  // And we return BEFORE registering the shutdown handlers below: those exist
  // to kill the services when the foreground CLI dies, which is precisely what
  // must not happen here.
  if (opts.detach) {
    logLauncherEvent('detached', `web=${webUrl} runner=${runnerUrl}`);
    console.log(chalk.gray('  Detached — the terminal is yours again.'));
    console.log(chalk.gray('  nodal-agents logs runner   follow a service'));
    console.log(chalk.gray('  nodal-agents down          stop everything'));
    // Said here because this is the last thing the user sees before the
    // terminal is theirs again — and after that, this file is the only place
    // the launcher can still tell them anything (issue #111, point 3).
    console.log(chalk.gray(`  ${LAUNCHER_LOG}   what the launcher saw`));
    console.log('');
    // The children were unref'd at spawn and Postgres is its own pg_ctl daemon,
    // so nothing here holds the loop — except the fire-and-forget version check
    // above, whose 3s timer would otherwise sit between the user and the prompt.
    process.exit(0);
  }

  console.log(chalk.gray('  Ctrl+C to stop all services'));
  console.log('');

  // ── 9c. Health watchdog — the launcher keeps LOOKING after the boot ───────
  // Constat du 23/08 : Postgres est mort sous une stack déclarée « healthy ».
  // Le Promise.race du bas n'attend que la mort des processus runner/web — un
  // Postgres mort ne tue ni l'un ni l'autre, donc rien ne le voyait. Le runner
  // sonde sa base à chaque GET /api/health (503 si morte) : on ré-interroge CE
  // health toutes les 30s et on nomme la panne dans le terminal, une fois par
  // transition. Pas de redémarrage automatique (invariant #4 — fail loud).
  // Foreground uniquement : en --detach le lanceur est déjà sorti, la vérité
  // vit alors dans /api/health (runner ET web pingent la base désormais).
  const watchdog: Watchdog = startHealthWatchdog({
    probe: () => probeRunnerHealth(runnerUrl),
    onTransition: (state, detail) => {
      const at = new Date().toLocaleTimeString();
      // The terminal gets local time for whoever is watching; the file gets a
      // UTC instant, because on 2026-09-15 nobody was watching and the terminal
      // was the only place this had ever been said.
      logLauncherEvent(state === 'healthy' ? 'recovered' : 'degraded', `state=${state} ${detail}`);
      if (state === 'healthy') {
        console.log(chalk.green(`\n  [${at}] Recovered — ${detail}.`));
        return;
      }
      console.error(chalk.red.bold(`\n  [${at}] DEGRADED — ${detail}.`));
      if (state === 'degraded') {
        console.error(
          chalk.red(
            '  The dashboard may still render, but nothing can read or write the database:\n' +
              '  jobs are not created, chats and schedules are failing.',
          ),
        );
        printLogTail('runner', 10);
      }
      console.error(
        chalk.yellow('  → Restart the stack: `nodal-agents down`, then `nodal-agents up`.'),
      );
    },
  });

  // ── 10. Stay up until a child exits ───────────────────────────────────────
  // SIGINT/SIGTERM are already handled — the handlers were registered back at
  // step 2b, as soon as Postgres came up, so the whole startup window is
  // covered and not just this point onwards.

  // Keep process alive until a child exits, then shut down
  // WHICH child exited is the question `%TEMP%\nodal-dev.log` could not answer
  // on 2026-09-15: the launcher said "Stopped. Goodbye!" and nothing else.
  const exited = await Promise.race([
    runnerProcess.then(() => 'runner' as const).catch(() => 'runner' as const),
    webProcess.then(() => 'web' as const).catch(() => 'web' as const),
  ]);
  logLauncherEvent('child-exited', `service=${exited}`);

  watchdog.stop();
  await shutdown(`${exited} exited`);
}
