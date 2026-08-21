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
} from '../lib/processes.ts';
import { PG_DATA_DIR } from '../lib/config.ts';
import { readPostmasterPid } from '../lib/postgres.ts';

/**
 * Stop one service by pid, tree and all, and report what actually happened.
 *
 * `process.kill(pid,'SIGTERM')` used to stand here, and it lied twice over on
 * Windows: it terminates only the named pid — in dev layout that's the cmd.exe
 * wrapper, leaving node.exe alive on :3000 — and it returns success either way,
 * so `down` printed "Stopped web" over a web that was still serving. Now the
 * whole tree is killed and the pid is re-probed before anything is claimed.
 */
async function killPid(pid: number, label: string): Promise<boolean> {
  if (!isPidAlive(pid)) {
    console.log(chalk.gray(`  ${label} (pid ${pid}) was already stopped`));
    return false;
  }
  await killPidTree(pid);
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
async function stopPostgresGracefully(): Promise<boolean> {
  const pidFile = join(PG_DATA_DIR, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;

  // Captured BEFORE the stop: pg.stop() removes the lockfile, so afterwards
  // there is nothing left to read the pid from.
  const pgPid = readPostmasterPid(PG_DATA_DIR);

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
      const killCmd =
        process.platform === 'win32'
          ? `powershell Stop-Process -Id ${pgPid} -Force`
          : `kill -9 ${pgPid}`;
      console.log(
        chalk.red(
          `  postgres (pid ${pgPid}) is STILL RUNNING after a graceful stop\n` +
            `    It holds the shared-memory block for the data dir, so the next ` +
            `\`up\` will fail.\n` +
            `    Fix: ${killCmd}`,
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

  let stopped = 0;

  if (pids?.runner) stopped += (await killPid(pids.runner, 'runner')) ? 1 : 0;
  if (pids?.web) stopped += (await killPid(pids.web, 'web')) ? 1 : 0;

  // The tree recorded at startup, when every parent/child link still existed.
  // `down` usually reaches everything through killPidTree, but not always: a
  // Next dev server outlives the launcher that spawned it, and after
  // `up --detach` the CLI that owned the tree is long gone.
  const swept = await sweepRecordedChildren(pids?.children ?? []);
  if (swept.length > 0) {
    console.log(chalk.green(`  Stopped ${swept.length} background worker(s) left behind`));
    stopped += swept.length;
  }

  if (await stopPostgresGracefully()) stopped++;

  clearPids();

  if (stopped === 0) {
    console.log(chalk.yellow('No running Nodal-Agents processes found.'));
    return;
  }

  console.log(chalk.green('\n  Nodal-Agents stopped.'));
}
