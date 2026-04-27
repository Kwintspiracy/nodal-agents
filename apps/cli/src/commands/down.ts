// down.ts — stop all background NodalAI processes

import chalk from 'chalk';
import { readPids, clearPids } from '../lib/processes.ts';

/**
 * Stop runner and web processes using PIDs from ~/.nodalai/pids/processes.json.
 */
export async function runDown(): Promise<void> {
  const pids = readPids();

  if (!pids || (!pids.runner && !pids.web)) {
    console.log(chalk.yellow('No running NodalAI processes found.'));
    return;
  }

  let stopped = 0;

  if (pids.runner) {
    try {
      process.kill(pids.runner, 'SIGTERM');
      console.log(chalk.green(`  Stopped runner (pid ${pids.runner})`));
      stopped++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        console.log(chalk.gray(`  Runner (pid ${pids.runner}) was already stopped`));
      } else {
        console.log(chalk.red(`  Failed to stop runner: ${String(err)}`));
      }
    }
  }

  if (pids.web) {
    try {
      process.kill(pids.web, 'SIGTERM');
      console.log(chalk.green(`  Stopped web (pid ${pids.web})`));
      stopped++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        console.log(chalk.gray(`  Web (pid ${pids.web}) was already stopped`));
      } else {
        console.log(chalk.red(`  Failed to stop web: ${String(err)}`));
      }
    }
  }

  clearPids();

  if (stopped > 0) {
    console.log(chalk.green('\n  NodalAI stopped.'));
  }
}
