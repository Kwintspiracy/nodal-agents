// down.ts — stop all background NodalAI processes (runner, web, postgres)

import chalk from 'chalk';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPids, clearPids } from '../lib/processes.ts';
import { PG_DATA_DIR } from '../lib/config.ts';

function killPid(pid: number, label: string): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(chalk.green(`  Stopped ${label} (pid ${pid})`));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      console.log(chalk.gray(`  ${label} (pid ${pid}) was already stopped`));
      return false;
    }
    console.log(chalk.red(`  Failed to stop ${label}: ${String(err)}`));
    return false;
  }
}

/**
 * Read the Postgres PID from pg-data/postmaster.pid (if present).
 * Postgres writes the PID on its first line of that file.
 */
function readPostgresPid(): number | null {
  const pidFile = join(PG_DATA_DIR, 'postmaster.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const firstLine = readFileSync(pidFile, 'utf-8').split(/\r?\n/)[0];
    const pid = Number.parseInt(firstLine ?? '', 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Wait briefly for a process to exit. Returns true if process is gone.
 */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Signal 0 just checks existence — throws ESRCH if process is gone
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Stop runner, web, and embedded Postgres. Runner+web PIDs are read from
 * ~/.nodalai/pids/processes.json; the Postgres PID is read from
 * pg-data/postmaster.pid (Postgres writes it there itself).
 */
export async function runDown(): Promise<void> {
  const pids = readPids();
  const pgPid = readPostgresPid();

  let stopped = 0;

  if (pids?.runner) stopped += killPid(pids.runner, 'runner') ? 1 : 0;
  if (pids?.web) stopped += killPid(pids.web, 'web') ? 1 : 0;

  if (pgPid !== null) {
    if (killPid(pgPid, 'postgres')) {
      stopped++;
      // Wait for it to release file locks (matters for `reset` which rm's pg-data)
      const exited = await waitForExit(pgPid);
      if (!exited) {
        console.log(chalk.yellow('  Postgres still running after 5s — sending SIGKILL'));
        try {
          process.kill(pgPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }

  clearPids();

  if (stopped === 0) {
    console.log(chalk.yellow('No running NodalAI processes found.'));
    return;
  }

  console.log(chalk.green('\n  NodalAI stopped.'));
}
