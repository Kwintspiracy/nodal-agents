// restore.ts — `nodal-agents restore <file>`: bring an install back from a
// backup, on this machine or another.
//
// The work is @nodal-agents/db/backup (`restoreBackup`): the archive is loaded
// into an EMPTY copy inside the cluster, counted, its master key proved
// against its secrets, and only then swapped in; the database it replaces is
// kept as a copy (`nodal-agents rollback` lists it and swaps it back), with
// the live key and config beside it. An archive from an older schema is then
// migrated by the normal path; one from a newer schema is refused before
// anything is created.
//
// What this command adds is what belongs to the home rather than the database:
//
//   - it refuses while anything of the home runs;
//   - a home with no install yet gets one first, exactly as the first `up`
//     makes it (new config, new cluster): one path, whatever the machine;
//   - the config: the backup's settings come back, except what belongs to
//     THIS machine's cluster, which a backup cannot carry: the ports and the
//     database password (`configAfterRestore`). The previous config stays as
//     `config.json.last-good`;
//   - the workspaces, when the backup holds them: extracted beside the live
//     folder, then swapped in, the replaced folder kept under a dated name;
//   - the folders given to agents that do not exist on this machine are named
//     (they are the person's own files, never in a backup).

import chalk from 'chalk';
import ora from 'ora';
import { existsSync, renameSync, statfsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  CONFIG_FILE,
  PG_DATA_DIR,
  createConfig,
  newInstallConfig,
  readConfig,
  writeConfig,
  type Config,
} from '../lib/config.ts';
import { refuseWhileRunning, withStartedCluster } from '../lib/cluster-session.ts';
import { readPassphrase } from '../lib/passphrase.ts';
import { getInstalledVersion } from '../lib/version.ts';
import { nodalHomeEntry } from '@nodal-agents/shared/nodal-home';
import { NODAL_CONFIG_FILE } from '@nodal-agents/shared/nodal-config-file';
import { lastGoodCopyPath } from '@nodal-agents/shared/state-files';
import { DEFAULT_SNAPSHOTS_KEPT, formatBytes, homeStateFiles } from '@nodal-agents/db/snapshots';
import type { RestoreBackupResult } from '@nodal-agents/db/backup';

/**
 * The config after a restore: the backup's, with what belongs to this
 * machine's cluster kept from the live one (the ports it listens on and the
 * password its role has). PURE.
 */
export function configAfterRestore(live: Config, archived: Config): Config {
  return {
    ...archived,
    ports: live.ports,
    postgresPassword: live.postgresPassword,
    postgresPasswordPending: live.postgresPasswordPending,
  };
}

function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export interface RestoreCommandOptions {
  readonly now?: () => Date;
}

export async function runRestore(file: string, opts: RestoreCommandOptions = {}): Promise<void> {
  refuseWhileRunning('A backup can only be restored');
  const archive = resolve(file);
  if (!existsSync(archive)) throw new Error(`There is no file at ${archive}.`);
  const now = opts.now ?? ((): Date => new Date());

  const { readBackupHeader, readBackupStateFiles, restoreBackup } =
    await import('@nodal-agents/db/backup');
  const passphrase =
    readBackupHeader(archive).header.encryption === null
      ? undefined
      : await readPassphrase({ confirm: false, purpose: `${archive} is protected and` });
  const { manifest, texts } = await readBackupStateFiles(
    archive,
    passphrase === undefined ? {} : { passphrase },
  );
  const configName = basename(CONFIG_FILE);
  const archivedConfigText = texts.get(configName);
  const archivedConfig =
    archivedConfigText === undefined ? null : NODAL_CONFIG_FILE.parse(archivedConfigText);

  // A home with no install gets one, as the first `up` makes it.
  let live = readConfig();
  if (live === null) {
    live = newInstallConfig();
    createConfig(live);
    console.log(
      chalk.gray(`  No install in this home yet: created ${CONFIG_FILE} for this machine.`),
    );
  }

  const liveWorkspaces = nodalHomeEntry('workspaces');
  const at = now();
  const staging = manifest.workspaces ? `${liveWorkspaces}.restoring-${stamp(at)}` : undefined;

  const spinner = ora(`Restoring ${archive}…`).start();
  let result: RestoreBackupResult;
  let missingFolders: string[] = [];
  try {
    result = await withStartedCluster(live, async ({ databaseUrl, vectorAvailable, config }) => {
      const restored = await restoreBackup(databaseUrl, {
        archive,
        ...(passphrase !== undefined ? { passphrase } : {}),
        vector: vectorAvailable,
        stateFiles: homeStateFiles(),
        ...(staging !== undefined ? { workspacesInto: staging } : {}),
        programVersion: getInstalledVersion(),
        keep: config.snapshots?.keep ?? DEFAULT_SNAPSHOTS_KEPT,
        freeBytes: () => {
          const fs = statfsSync(PG_DATA_DIR);
          return Number(fs.bavail) * Number(fs.bsize);
        },
        onStep: (text) => {
          spinner.text = text;
        },
      });
      missingFolders = await agentFoldersMissingHere(databaseUrl);
      return restored;
    });
  } catch (err) {
    spinner.fail('The backup was not restored');
    if (staging !== undefined && existsSync(staging)) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `  The workspaces of the backup were extracted to ${staging} and were not put in place.`,
        { cause: err },
      );
    }
    throw err;
  }

  // The config: the backup's settings, this machine's cluster.
  const current = readConfig();
  if (archivedConfig !== null && current !== null) {
    writeConfig(configAfterRestore(current, archivedConfig));
  }

  // The workspaces: swapped in, the replaced folder kept.
  let replacedWorkspaces: string | null = null;
  if (staging !== undefined) {
    if (existsSync(liveWorkspaces)) {
      replacedWorkspaces = `${liveWorkspaces}.replaced-${stamp(at)}`;
      renameSync(liveWorkspaces, replacedWorkspaces);
    }
    renameSync(staging, liveWorkspaces);
  }

  spinner.succeed(chalk.green(`Restored ${archive}`));
  const m = result.manifest;
  console.log(
    `  Made by ${m.madeBy} on ${m.at}; schema up to ${m.schema.lastMigration ?? '(none)'}.` +
      ` ${result.tables} tables, ${result.rows} rows loaded and counted.`,
  );
  console.log(
    `  The database it replaced is kept as ${result.replaced.name} ` +
      `(${formatBytes(result.replaced.sizeBytes)}): \`nodal-agents rollback ${result.replaced.name}\` swaps it back.`,
  );
  for (const f of result.putBack) {
    console.log(
      f.previous === 'missing'
        ? `  ${f.path}: the master key of the backup.`
        : `  ${f.path}: now the master key of the backup; the previous one is kept with ${result.replaced.name}.`,
    );
  }
  if (archivedConfig !== null) {
    const lastGood = lastGoodCopyPath(CONFIG_FILE);
    console.log(
      `  ${CONFIG_FILE}: the settings of the backup, with this machine's ports and database ` +
        `password.${existsSync(lastGood) ? ` The previous version is ${lastGood}.` : ''}`,
    );
  }
  if (result.migrated.applied.length > 0) {
    console.log(
      `  Migrated to this version: ${result.migrated.applied.length} migration` +
        `${result.migrated.applied.length === 1 ? '' : 's'}` +
        (result.migrated.snapshot ? ` (copy ${result.migrated.snapshot.name} taken first).` : '.'),
    );
  }
  console.log(
    result.proof === null
      ? '  The backup holds no stored credential to check the key against.'
      : `  Checked: ${result.proof} decrypts with the restored master key.`,
  );
  if (staging !== undefined) {
    console.log(
      `  Workspaces: ${result.workspaceFiles} files put in ${liveWorkspaces}` +
        (replacedWorkspaces !== null
          ? `; the previous folder is kept as ${replacedWorkspaces}.`
          : '.'),
    );
  }
  if (missingFolders.length > 0) {
    console.log(
      chalk.yellow(
        `  Folders given to agents that do not exist on this machine (they are your own files,\n` +
          `  never in a backup; copy them here or change the agents' folders):\n` +
          missingFolders.map((p) => `    ${p}`).join('\n'),
      ),
    );
  }
  console.log('\n  Start it with: nodal-agents up');
}

/** The agent folders the restored database names that this machine does not have. */
async function agentFoldersMissingHere(databaseUrl: string): Promise<string[]> {
  const { createClient, agentWorkspaces } = await import('@nodal-agents/db');
  const { db, close } = createClient(databaseUrl, { max: 1 });
  try {
    const rows = await db.select({ path: agentWorkspaces.path }).from(agentWorkspaces);
    return [...new Set(rows.map((r) => r.path))].filter((p) => !existsSync(p)).sort();
  } finally {
    await close();
  }
}
