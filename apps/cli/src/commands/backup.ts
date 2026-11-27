// backup.ts — `nodal-agents backup`: everything this install needs to live
// again, in one verified file.
//
// The work is @nodal-agents/db/backup (`createBackup`): every table through
// the driver in one snapshot, the master key and the config, optionally the
// workspaces folder; written under a temporary name, read back and compared
// with the database, then renamed. This command picks the folder, reaches the
// database (the running stack's, or a cluster started for the occasion, the
// way `rollback` does), and says in plain words what the file holds and where
// it is.
//
// The default folder is `<home>/backups`: inside the home, so a confined
// agent command cannot read it (the sandbox refuses the whole home), and
// per instance. It is on the same disk as the install, which the output says:
// a backup survives the loss of the disk only once it is copied elsewhere.

import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, PG_DATA_DIR, readConfig } from '../lib/config.ts';
import { homeHasCluster, withHomeDatabase } from '../lib/cluster-session.ts';
import { readPassphrase } from '../lib/passphrase.ts';
import { getInstalledVersion } from '../lib/version.ts';
import { nodalHomeEntry, nodalHomePath } from '@nodal-agents/shared/nodal-home';
import { formatBytes, homeStateFiles } from '@nodal-agents/db/snapshots';
import { masterKeyFilePath } from '@nodal-agents/shared/state-files';
import type { BackupResult } from '@nodal-agents/db/backup';

export interface BackupCommandOptions {
  /** The folder to write to; default `<home>/backups`. */
  readonly to?: string;
  /** Include the home's workspaces folder. */
  readonly withWorkspaces?: boolean;
  /** Protect the archive with a passphrase. */
  readonly passphrase?: boolean;
  /** Keep only the newest N backups of the folder once this one is verified. */
  readonly keep?: number;
}

/** The folder a backup goes to. */
export function backupFolder(to: string | undefined): string {
  return to === undefined ? nodalHomePath('backups') : resolve(to);
}

export async function runBackup(opts: BackupCommandOptions = {}): Promise<void> {
  const config = readConfig();
  if (config === null || !homeHasCluster()) {
    throw new Error(
      `There is no Nodal-Agents database in this home (${config === null ? `no ${CONFIG_FILE}` : `no cluster in ${PG_DATA_DIR}`}): nothing to back up.`,
    );
  }
  if (opts.keep !== undefined && (!Number.isInteger(opts.keep) || opts.keep < 1)) {
    throw new Error(`--keep must be a whole number of at least 1, not ${String(opts.keep)}.`);
  }
  const dir = backupFolder(opts.to);
  const passphrase = opts.passphrase
    ? await readPassphrase({ confirm: true, purpose: 'A protected backup' })
    : undefined;

  const spinner = ora('Backing up…').start();
  let result: BackupResult;
  try {
    const { createBackup } = await import('@nodal-agents/db/backup');
    result = await withHomeDatabase(config, ({ databaseUrl }) =>
      createBackup(databaseUrl, {
        dir,
        stateFiles: homeStateFiles(),
        ...(opts.withWorkspaces ? { workspacesDir: nodalHomeEntry('workspaces') } : {}),
        ...(passphrase !== undefined ? { passphrase } : {}),
        ...(opts.keep !== undefined ? { keep: opts.keep } : {}),
        programVersion: getInstalledVersion(),
        onStep: (text) => {
          spinner.text = text;
        },
      }),
    );
  } catch (err) {
    spinner.fail('No backup was made');
    throw err;
  }
  spinner.succeed(chalk.green(`Backup written and verified: ${result.path}`));

  const keyPath = masterKeyFilePath();
  console.log(
    `  ${formatBytes(result.bytes)}. Read back and compared with the database: ` +
      `${result.tables.length} tables, ${result.rows} rows, ${result.sequences} sequences, identical.`,
  );
  console.log(
    `  Schema up to ${result.manifest.schema.lastMigration ?? '(none)'}, made by ${result.manifest.madeBy}.`,
  );
  if (result.workspaces !== null) {
    console.log(
      `  Workspaces: ${result.workspaces.files} files (${formatBytes(result.workspaces.bytes)}) in ` +
        `${result.workspaces.dirs} folders.`,
    );
    if (result.workspaces.skipped.length > 0) {
      console.log(
        chalk.yellow(
          `  Not copied (neither a folder nor a regular file, such as links): ` +
            result.workspaces.skipped.join(', '),
        ),
      );
    }
  } else {
    console.log(chalk.gray('  Workspaces not included (add --with-workspaces to include them).'));
  }
  console.log(
    result.keyProof === null
      ? '  The database holds no stored credential yet.'
      : `  The master key in it opens the database's secrets (${result.keyProof} decrypted).`,
  );
  console.log('');
  if (result.encrypted) {
    console.log(
      chalk.yellow(
        `  This file holds the master key (${keyPath}) and every stored credential, encrypted with\n` +
          '  your passphrase. Without the passphrase this backup cannot be restored: nobody can recover it.',
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        `  This file holds the master key (${keyPath}) in clear: anyone who has the file can read\n` +
          '  every stored credential, LLM key and bot token. Keep it where only you can read it\n' +
          '  (or make the next one with --passphrase).',
      ),
    );
  }
  if (dir.startsWith(CONFIG_DIR)) {
    console.log(
      chalk.yellow(
        '  It is on the same disk as the install, inside its folder: copy it to another disk or\n' +
          '  machine to survive the loss of this one. `nodal-agents reset` deletes this folder too.',
      ),
    );
  }
  if (result.pruned.length > 0) {
    console.log(
      chalk.gray(`  Older backups removed (keeping ${opts.keep}): ${result.pruned.join(', ')}`),
    );
  }
  console.log(
    `\n  To restore it, here or on another machine: nodal-agents restore "${result.path}"`,
  );
}
