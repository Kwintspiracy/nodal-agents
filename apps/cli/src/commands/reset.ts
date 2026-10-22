// reset.ts — nuke this instance's home (NODALAI_HOME, or ~/.nodalai/) and start fresh

import chalk from 'chalk';
import prompts from 'prompts';
import { rmSync, existsSync } from 'fs';
import { unregisterNodalInstance } from '@nodal-agents/shared/nodal-instances';
import { join } from 'node:path';
import { CONFIG_DIR, PG_DATA_DIR } from '../lib/config.ts';
import {
  describeUnstopped,
  inspectPidCommand,
  postgresStopByHandLines,
  runDown,
  type DownResult,
} from './down.ts';

/**
 * `down` is a parameter so that the decision on its result can be tested for
 * every reason it can give, on every platform.
 */
export async function runReset(
  options: { yes?: boolean } = {},
  down: () => Promise<DownResult> = runDown,
): Promise<void> {
  if (!options.yes) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: chalk.red(
        `This will delete ALL Nodal-Agents data at ${CONFIG_DIR} (config, database, logs). Are you sure?`,
      ),
      initial: false,
    });

    if (!confirm) {
      console.log(chalk.gray('Reset cancelled.'));
      return;
    }
  }

  // Stop any running processes first
  console.log(chalk.yellow('Stopping any running processes…'));
  const { unstopped } = await down();

  // One rule, decided from the REASON `down` gives for each service it did not
  // stop. The data directory is deleted only when no service of this install
  // can still be using it:
  //   - ours and alive, or nothing identifies it (it may well be ours): block;
  //   - could not be confirmed either way (macOS, #840): block;
  //   - a lockfile with no readable pid: block, nothing proves no server runs;
  //   - a Postgres pid that a reading PROVED is not this install's postmaster
  //     (a stranger that inherited a dead postmaster's number): it holds
  //     nothing of ours, so it does not block, and it is never touched.
  const blocking = unstopped.filter((u) => u.reason !== 'foreign');
  for (const u of unstopped.filter((x) => x.reason === 'foreign')) {
    console.log(
      chalk.gray(
        `  postgres (pid ${u.pid}) is not this install's postmaster: left alone, ` +
          'its stale lockfile is deleted with the data directory.',
      ),
    );
  }
  if (blocking.length > 0) {
    const remedies: string[] = [];
    for (const u of blocking) {
      remedies.push(`  - ${describeUnstopped(u)}`);
      if (u.reason === 'no-pid') {
        remedies.push(
          `    Check that no postgres runs on ${PG_DATA_DIR}, then delete ` +
            `${join(PG_DATA_DIR, 'postmaster.pid')} yourself.`,
        );
      } else if (u.service === 'postgres') {
        remedies.push(...(await postgresStopByHandLines(u.pid)));
      } else if (u.pid !== null) {
        remedies.push(
          `    Look at it: ${inspectPidCommand(u.pid)}`,
          `    If it is this install's ${u.service}, stop it yourself.`,
        );
      }
    }
    throw new Error(
      `Nothing was deleted. Still there:\n${remedies.join('\n')}\n` +
        'Deal with it as described, then run `nodal-agents reset` again.',
    );
  }

  // Remove the config directory
  if (existsSync(CONFIG_DIR)) {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    console.log(chalk.green(`  Removed ${CONFIG_DIR}`));
  } else {
    console.log(chalk.gray(`  ${CONFIG_DIR} was already empty`));
  }
  // Its entry in the registry of instances goes with it (an `up` writes it back).
  unregisterNodalInstance();

  console.log('');
  console.log(chalk.green('  Reset complete.'));
  console.log(chalk.gray('  Run `nodal-agents init` to configure from scratch.'));
}
