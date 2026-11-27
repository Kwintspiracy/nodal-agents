// rollback.ts — `nodal-agents rollback [snapshot]`: go back to a copy of the
// database taken before a migration (or the database a restore replaced).
//
// ONE command, not a procedure. Without an argument it lists the copies the
// cluster holds, newest first, with when they were taken, how far their
// schema went and which version last opened them. With a name it swaps that
// copy back in: the current database is KEPT under a snapshot name of its own
// (never dropped), in one transaction (`restoreSnapshot`,
// @nodal-agents/db/snapshots — the module the migration path and `restore`
// use too). The master key travels with its database both ways.
//
// It refuses while Nodal runs: a swap needs no session on either database, and
// a running stack holds both the database and its own idea of what is in it.
// It starts the embedded cluster itself, the way `up` does
// (lib/cluster-session.ts, shared with `backup` and `restore`), and stops it
// once done.

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readConfig, CONFIG_FILE, PG_DATA_DIR } from '../lib/config.ts';
import { homeHasCluster, refuseWhileRunning, withStartedCluster } from '../lib/cluster-session.ts';
import { getInstalledVersion } from '../lib/version.ts';
import { readOpenedBy, readSchemaState } from '@nodal-agents/db/schema-state';
import {
  DEFAULT_SNAPSHOTS_KEPT,
  formatBytes,
  homeStateFiles,
  listSnapshots,
  restoreSnapshot,
  type Snapshot,
} from '@nodal-agents/db/snapshots';

export interface RollbackOptions {
  /** The snapshot to swap back in; omitted, the snapshots are listed. */
  readonly name?: string;
}

function describe(s: Snapshot): string[] {
  if (s.meta === null) {
    return [
      `  ${chalk.yellow(s.name)}  (${formatBytes(s.sizeBytes)}) incomplete: never finished, cannot be put back`,
    ];
  }
  const m = s.meta;
  const why =
    m.kind === 'replaced-by-rollback'
      ? `the database a rollback replaced (by ${m.madeBy})`
      : m.kind === 'replaced-by-restore'
        ? `the database a restore from a backup replaced (by ${m.madeBy})`
        : m.kind === 'from-backup'
          ? `restored from a backup by ${m.madeBy}`
          : `taken by ${m.madeBy} before it migrated`;
  return [
    `  ${chalk.cyan(s.name)}`,
    `      taken     ${m.at}, ${why}`,
    `      schema    up to ${m.lastMigration ?? '(no migration)'}`,
    `      opened by ${m.lastOpenedBy ?? '(not recorded)'}`,
    `      size      ${formatBytes(s.sizeBytes)}; saved beside it: ${m.stateFiles.length > 0 ? m.stateFiles.join(', ') : 'nothing'}`,
  ];
}

export async function runRollback(opts: RollbackOptions = {}): Promise<void> {
  refuseWhileRunning('A copy can only be swapped back');

  const config = readConfig();
  if (config === null || !homeHasCluster()) {
    throw new Error(
      `There is no Nodal-Agents database in this home (${config === null ? `no ${CONFIG_FILE}` : `no cluster in ${PG_DATA_DIR}`}): nothing to roll back.`,
    );
  }

  await withStartedCluster(config, async ({ databaseUrl, vectorAvailable, config: current }) => {
    const stateFiles = homeStateFiles();
    const keep = current.snapshots?.keep ?? DEFAULT_SNAPSHOTS_KEPT;

    if (opts.name === undefined) {
      const list = await listSnapshots(databaseUrl, stateFiles.dir);
      if (list.length === 0) {
        console.log('No copy of the database exists yet. One is taken before every migration.');
        return;
      }
      console.log(chalk.bold(`Copies of the database, newest first (${list.length}):\n`));
      for (const s of list) console.log(describe(s).join('\n') + '\n');
      console.log(
        chalk.gray(
          `  Nodal keeps the last ${keep} (config.json "snapshots": { "keep": N }).\n` +
            '  To swap one back (the current database is kept as a copy):\n\n' +
            '    nodal-agents rollback <name>',
        ),
      );
      return;
    }

    const programVersion = getInstalledVersion();
    const currentState = await readSchemaState(databaseUrl, {
      patchVectorAsText: !vectorAvailable,
    });
    const openedBy = await readOpenedBy(databaseUrl);
    const recorded = openedBy !== null && openedBy !== 'unreadable' ? openedBy : null;
    const result = await restoreSnapshot(databaseUrl, opts.name, {
      at: new Date(),
      madeBy: programVersion,
      stateFiles,
      // The current database may be newer than this program (the usual reason
      // to roll back): its newest migration is then named by its own record.
      currentLastMigration: currentState.lastApplied?.tag ?? recorded?.lastMigration ?? null,
      currentOpenedBy: recorded?.version ?? null,
    });
    const after = await readSchemaState(databaseUrl, { patchVectorAsText: !vectorAvailable });

    const restored = result.restored.meta;
    console.log(chalk.green(`✓ The database is now the copy ${result.restored.name}.`));
    console.log(
      `  It was taken ${restored?.at ?? '(unknown time)'}; its schema goes up to ${restored?.lastMigration ?? '(no migration)'}.`,
    );
    console.log(
      `  The database it replaced is kept as ${result.replaced.name} ` +
        `(${formatBytes(result.replaced.sizeBytes)}): \`nodal-agents rollback ${result.replaced.name}\` swaps it back.`,
    );
    for (const file of result.putBack) {
      console.log(
        file.previous === 'missing'
          ? `  ${file.path} was missing and was put back from the copy.`
          : `  ${file.path} is now the one saved with the copy; the previous one is kept with ${result.replaced.name}.`,
      );
    }
    const savedConfig = join(result.restored.stateDir, basename(CONFIG_FILE));
    if (existsSync(savedConfig)) {
      console.log(
        chalk.gray(
          `  config.json was not changed (its database password and ports are the cluster's);\n` +
            `  the one saved with the copy is ${savedConfig}.`,
        ),
      );
    }
    if (after.unknown.length > 0 || after.pending.length > 0) {
      const wanted = restored?.lastOpenedBy ?? null;
      console.log(
        chalk.yellow(
          after.pending.length > 0
            ? `\n  This program (${programVersion}) would migrate it again at its next start ` +
                `(${after.pending.length} migration${after.pending.length === 1 ? '' : 's'}).`
            : `\n  This program (${programVersion}) is older than this copy and will not open it.`,
        ),
      );
      console.log(
        chalk.yellow(
          wanted !== null
            ? `  To run on it, install the version that last opened it first:\n\n    npm install -g nodal-agents@${wanted}\n`
            : '  To run on it, install the version it was taken from first (it did not record which).\n',
        ),
      );
    } else {
      console.log('\n  Start it with: nodal-agents up');
    }
  });
}
