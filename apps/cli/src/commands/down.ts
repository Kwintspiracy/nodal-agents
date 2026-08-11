// down.ts — stop all background Nodal-Agents processes (runner, web, postgres)

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPids, clearPids, isPidAlive, killPidTree } from '../lib/processes.ts';
import { PG_DATA_DIR } from '../lib/config.ts';

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

  if (await stopPostgresGracefully()) stopped++;

  clearPids();

  if (stopped === 0) {
    console.log(chalk.yellow('No running Nodal-Agents processes found.'));
    return;
  }

  console.log(chalk.green('\n  Nodal-Agents stopped.'));
}
