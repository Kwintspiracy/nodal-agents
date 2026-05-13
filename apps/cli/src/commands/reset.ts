// reset.ts — nuke ~/.nodalai/ and start fresh

import chalk from 'chalk';
import prompts from 'prompts';
import { rmSync, existsSync } from 'fs';
import { CONFIG_DIR } from '../lib/config.ts';
import { runDown } from './down.ts';

export async function runReset(options: { yes?: boolean } = {}): Promise<void> {
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
  await runDown();

  // Remove the config directory
  if (existsSync(CONFIG_DIR)) {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    console.log(chalk.green(`  Removed ${CONFIG_DIR}`));
  } else {
    console.log(chalk.gray(`  ${CONFIG_DIR} was already empty`));
  }

  console.log('');
  console.log(chalk.green('  Reset complete.'));
  console.log(chalk.gray('  Run `nodal-agents init` to configure from scratch.'));
}
