// reset.ts — nuke this instance's home (NODALAI_HOME, or ~/.nodalai/) and start fresh

import chalk from 'chalk';
import prompts from 'prompts';
import { rmSync, existsSync, readdirSync, readlinkSync, realpathSync, renameSync } from 'fs';
import { unregisterNodalInstance } from '@nodal-agents/shared/nodal-instances';
import { join, sep } from 'node:path';
import { CONFIG_DIR, PG_DATA_DIR } from '../lib/config.ts';
import {
  describeUnstopped,
  inspectPidCommand,
  postgresStopByHandLines,
  runDown,
  type DownResult,
} from './down.ts';

/**
 * The processes (other than this one) that have `dir` as their working
 * directory, as far as the platform lets us look: Linux only, through
 * `/proc/<pid>/cwd`. A postmaster `chdir()`s into its data directory and stays
 * there, so this is the holder a rename would NOT notice on Unix (an open file
 * does not stop a directory from being renamed there).
 */
export function findWorkingDirectoryHolders(dir: string): number[] {
  if (process.platform !== 'linux') return [];
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return [];
  }
  const holders: number[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === root || cwd.startsWith(root + sep)) holders.push(pid);
    } catch {
      /* not ours to look at, or gone */
    }
  }
  return holders;
}

/** What `runReset` does to the disk, replaceable so the failure paths can be exercised. */
export interface ResetDisk {
  rename: (from: string, to: string) => void;
  findHolders: (dir: string) => number[];
}

const realDisk: ResetDisk = { rename: renameSync, findHolders: findWorkingDirectoryHolders };

/**
 * Set the data directory ASIDE before anything is deleted: an atomic rename.
 *
 * Deleting it in place is not safe whatever the verdict was. On Windows
 * `rmSync` removes the files nothing holds, then throws on the first one that
 * something does — a postmaster we could not see, an antivirus, an indexer —
 * leaving a half-deleted cluster. A rename of a directory fails outright while
 * a process holds a file or a working directory inside it, and it fails BEFORE
 * deleting anything. On Unix a rename succeeds regardless, so the holders are
 * looked for first, as far as the platform allows.
 */
function setDataDirAside(disk: ResetDisk): void {
  if (!existsSync(PG_DATA_DIR)) return;
  const holders = disk.findHolders(PG_DATA_DIR);
  if (holders.length > 0) {
    throw new Error(
      `Nothing was deleted: process ${holders.join(', ')} runs out of ${PG_DATA_DIR}. ` +
        'Stop it, then run `nodal-agents reset` again.',
    );
  }
  const aside = `${PG_DATA_DIR}.deleting-${Date.now()}`;
  try {
    disk.rename(PG_DATA_DIR, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(
      `Nothing was deleted: ${PG_DATA_DIR} could not be set aside (${code}). Something holds ` +
        'a file or a folder inside it: a Postgres this tool could not see, an antivirus, an ' +
        'indexer or a shell sitting in it. Close it, then run `nodal-agents reset` again.',
    );
  }
}

/**
 * `down` and `disk` are parameters so that the decision on `down`'s result, and
 * the failure of the delete, can be tested on every platform.
 */
export async function runReset(
  options: { yes?: boolean } = {},
  down: () => Promise<DownResult> = runDown,
  disk: ResetDisk = realDisk,
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

  // The data directory first, and by rename: if anything holds it, this fails
  // loud and NOTHING has been deleted (config and logs included).
  setDataDirAside(disk);

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
