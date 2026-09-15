// down.ts — stop all background Nodal-Agents processes (runner, web, postgres)

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readPids,
  clearPids,
  isPidAlive,
  killPidTree,
  waitForPidDead,
  sweepRecordedChildren,
  processSnapshotWin,
  recordedRoot,
  type PidFile,
  type ProcessRecord,
} from '../lib/processes.ts';
import { PG_DATA_DIR } from '../lib/config.ts';
import { readPostmasterPid, postgresProcessesForDataDir } from '../lib/postgres.ts';
import { confirmRecordedPid, formatRefusal, type LiveProcess } from '../lib/pid-confirm.ts';

/** Everything a kill decision needs, read ONCE and shared by the whole run. */
interface KillContext {
  pids: PidFile | null;
  snapshot: Map<number, ProcessRecord>;
  ownedPostgresPids: ReadonlySet<number>;
  /**
   * Whether this platform can produce a process table AT ALL.
   *
   * Not the same as "the reading failed". Windows can and does; nothing else
   * here can, and refusing to stop the stack on a machine that was never going
   * to answer would break `down` on macOS and Linux outright to close a hole
   * that only exists where pids are recycled aggressively. Where no reading is
   * possible the old behaviour stands and the line says so — the identity was
   * not confirmed, and that is stated rather than implied.
   */
  tableAvailable: boolean;
  /**
   * Whether a postgres ownership READING could be taken at all. False means the
   * question went unanswered — a different fact from "the answer was no", and
   * the two license different actions (invariant #4).
   */
  postgresReadingWorked: boolean;
}

/** A snapshot row in the shape `pid-confirm` reads, or undefined. */
function liveOf(snapshot: Map<number, ProcessRecord>, pid: number): LiveProcess | undefined {
  const rec = snapshot.get(pid);
  return rec === undefined
    ? undefined
    : { pid: rec.pid, startedAt: rec.startedAt, name: rec.name ?? '' };
}

/**
 * Stop one service by pid, tree and all, and report what actually happened.
 *
 * `process.kill(pid,'SIGTERM')` used to stand here, and it lied twice over on
 * Windows: it terminates only the named pid — in dev layout that's the cmd.exe
 * wrapper, leaving node.exe alive on :3000 — and it returns success either way,
 * so `down` printed "Stopped web" over a web that was still serving. Now the
 * whole tree is killed and the pid is re-probed before anything is claimed.
 */
async function killPid(pid: number, label: string, ctx: KillContext): Promise<boolean> {
  if (!isPidAlive(pid)) {
    console.log(chalk.gray(`  ${label} (pid ${pid}) was already stopped`));
    return false;
  }
  if (!ctx.tableAvailable) {
    console.log(
      chalk.gray(`  ${label} (pid ${pid}) — no process table on this platform to confirm it with`),
    );
    await killPidTree(pid, ctx.ownedPostgresPids);
    if (isPidAlive(pid)) {
      console.log(chalk.red(`  ${label} (pid ${pid}) is STILL RUNNING after SIGTERM then SIGKILL`));
      return false;
    }
    console.log(chalk.green(`  Stopped ${label} (pid ${pid})`));
    return true;
  }

  // CONFIRM, then signal — never the other way round (issue #100).
  //
  // `down` read this number out of a file that may be days old and handed it
  // straight to a tree kill. Windows reuses pid numbers, so the number alone
  // said nothing about whether the process now carrying it is the service we
  // started; `recordServiceTree` now writes the creation tick and the
  // executable name next to it, and this is where they are spent.
  const verdict = confirmRecordedPid({
    recorded: recordedRoot(ctx.pids, pid),
    live: liveOf(ctx.snapshot, pid),
    tableRead: ctx.snapshot.size > 0,
    ownedPostgresPids: ctx.ownedPostgresPids,
  });
  if (!verdict.killable) {
    console.log(
      chalk.yellow(
        `  ${label} (pid ${pid}) was NOT stopped — ${verdict.detail}.\n` +
          `    Nodal-Agents does not kill a pid it cannot identify. Nothing was signalled.`,
      ),
    );
    process.stderr.write(`${formatRefusal(verdict)}\n`);
    return false;
  }
  await killPidTree(pid, ctx.ownedPostgresPids);
  if (isPidAlive(pid)) {
    console.log(chalk.red(`  ${label} (pid ${pid}) is STILL RUNNING after SIGTERM then SIGKILL`));
    return false;
  }
  console.log(chalk.green(`  Stopped ${label} (pid ${pid})`));
  return true;
}

/**
 * Stop the embedded Postgres gracefully via `pg.stop()` (which invokes
 * `pg_ctl stop -m fast`). A clean shutdown releases the Win32 shared-memory
 * section properly; a hard SIGTERM/SIGKILL on the postmaster pid leaves
 * orphaned kernel objects and the next `up` then fails with "pre-existing
 * shared memory block is still in use" until the machine reboots.
 *
 * Returns true if a stop was attempted (postmaster.pid existed), false if
 * Postgres wasn't running per its lockfile.
 */
async function stopPostgresGracefully(ctx: KillContext): Promise<boolean> {
  const pidFile = join(PG_DATA_DIR, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;

  // Captured BEFORE the stop: pg.stop() removes the lockfile, so afterwards
  // there is nothing left to read the pid from.
  const pgPid = readPostmasterPid(PG_DATA_DIR);

  // Is that pid CONFIRMED ours, refused, or simply unknowable? Three states,
  // and #100 turns on telling them apart.
  //
  //   - confirmed: the data dir claims it and a fresh reading agrees;
  //   - refused: a reading was taken and it did NOT agree, which means the
  //     lockfile names somebody else's process. Nothing is signalled;
  //   - unknowable: no reading could be taken at all. That is the ordinary case
  //     off Windows, where `postgresProcessesForDataDir` has neither a process
  //     table nor `/proc` to lean on. The graceful stop still runs, because
  //     `pg.stop()` is how this product has always stopped its own cluster and
  //     refusing here would leave macOS unable to stop anything — but the HARD
  //     KILL suggestion below is withheld, which is the line #100 actually asks
  //     for: never recommend a force-kill against a pid nobody identified.
  const confirmed = pgPid !== null && ctx.ownedPostgresPids.has(pgPid);
  const refused = pgPid !== null && !confirmed && ctx.postgresReadingWorked;
  if (refused) {
    console.log(
      chalk.yellow(
        `  postgres (pid ${pgPid}) was NOT stopped — postmaster.pid names it, but a fresh\n` +
          `    reading could not confirm it belongs to ${PG_DATA_DIR}.\n` +
          `    Nothing was signalled. Check that pid yourself before touching it.`,
      ),
    );
    process.stderr.write(`KILL_REFUSED code=FOREIGN_POSTGRES pid=${pgPid} lockfile=${pidFile}\n`);
    return false;
  }

  try {
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    // Re-create the handle pointing at the existing data dir. The constructor
    // doesn't connect or start; .stop() reads postmaster.pid and signals the
    // postmaster the same way pg_ctl does.
    const pg = new EmbeddedPostgres({
      databaseDir: PG_DATA_DIR,
      user: 'nodalai',
      password: 'nodalai',
      // port is required by the type but only used for connection-time
      // operations, not for stop().
      port: 25432,
      persistent: true,
      onError: () => {},
      onLog: () => {},
    });
    await pg.stop();

    // RE-PROBE before claiming anything. `pg.stop()` resolving means pg_ctl was
    // invoked, not that the postmaster is gone — and this is the one service
    // whose survival poisons the NEXT boot, because a live postmaster keeps the
    // Win32 shared-memory section attached to the data dir and the next `up`
    // then dies on FATAL "pre-existing shared memory block is still in use".
    // Claiming "Stopped postgres (graceful)" over a postgres that is still
    // running is exactly the lie this file's header says was fixed for
    // runner/web, and it sent a real diagnosis down the wrong path on
    // 2026-08-20. Same discipline as killPid above: verify, then speak.
    // …but give it a moment to actually go. `pg_ctl stop -m fast` returns once
    // the signal is delivered, not once the postmaster has finished rolling back
    // and detaching its shared memory — a second or two on a busy machine, more
    // while background workers wind down. Probing the instant it returns made
    // `down` announce a stuck Postgres, in red, with a Stop-Process command to
    // run, three times out of three in an external validation on 2026-08-21 —
    // and all three pids were gone seconds later.
    //
    // A warning that cries wolf is worse than none: this same message DOES
    // report a real, boot-poisoning failure, and it only keeps that weight if it
    // never fires on a Postgres that was merely still on its way out.
    const pgGone = pgPid === null || (await waitForPidDead(pgPid, 15_000));
    if (!pgGone) {
      // The command is printed only for a pid we CONFIRMED. Handing the user a
      // force-kill for a number nobody identified is the same defect as making
      // the kill ourselves, one indirection removed (#100, path 3).
      const killCmd =
        process.platform === 'win32'
          ? `powershell Stop-Process -Id ${pgPid} -Force`
          : `kill -9 ${pgPid}`;
      console.log(
        chalk.red(
          `  postgres (pid ${pgPid}) is STILL RUNNING after a graceful stop\n` +
            `    It holds the shared-memory block for the data dir, so the next ` +
            `\`up\` will fail.\n` +
            (confirmed
              ? `    Fix: ${killCmd}`
              : `    Its identity could NOT be confirmed, so no kill command is suggested:\n` +
                `    check that pid yourself (its executable, its start time, which cluster\n` +
                `    it serves) and stop it through its owner.`),
        ),
      );
      return false;
    }

    console.log(chalk.green('  Stopped postgres (graceful)'));
    return true;
  } catch (err) {
    console.log(chalk.red(`  Failed to stop postgres gracefully: ${String(err)}`));
    return false;
  }
}

/**
 * Stop runner, web, and embedded Postgres. Runner+web PIDs are read from
 * ~/.nodalai/pids/processes.json; Postgres is stopped via `pg_ctl stop`
 * (NEVER via raw kill — see stopPostgresGracefully for the rationale).
 */
export async function runDown(): Promise<void> {
  const pids = readPids();

  // ONE reading of the process table and ONE of postgres ownership, shared by
  // every decision below. Two readings would let a pid be refused by the first
  // and accepted by the second — the shape of the pass-4 finding on #98.
  const pgReading = await postgresProcessesForDataDir();
  const ctx: KillContext = {
    pids,
    tableAvailable: process.platform === 'win32',
    snapshot: await processSnapshotWin(),
    ownedPostgresPids: new Set(pgReading.owned),
    postgresReadingWorked: pgReading.read,
  };

  let stopped = 0;

  if (pids?.runner) stopped += (await killPid(pids.runner, 'runner', ctx)) ? 1 : 0;
  if (pids?.web) stopped += (await killPid(pids.web, 'web', ctx)) ? 1 : 0;

  // The tree recorded at startup, when every parent/child link still existed.
  // `down` usually reaches everything through killPidTree, but not always: a
  // Next dev server outlives the launcher that spawned it, and after
  // `up --detach` the CLI that owned the tree is long gone.
  const swept = await sweepRecordedChildren(pids?.children ?? [], ctx.ownedPostgresPids);
  if (swept.length > 0) {
    console.log(chalk.green(`  Stopped ${swept.length} background worker(s) left behind`));
    stopped += swept.length;
  }

  if (await stopPostgresGracefully(ctx)) stopped++;

  clearPids();

  if (stopped === 0) {
    console.log(chalk.yellow('No running Nodal-Agents processes found.'));
    return;
  }

  console.log(chalk.green('\n  Nodal-Agents stopped.'));
}
