// rollback.ts — `nodal-agents rollback [snapshot]`: go back to a copy of the
// database taken before a migration.
//
// ONE command, not a procedure. Without an argument it lists the copies the
// cluster holds, newest first, with when they were taken, how far their
// schema went and which version last opened them. With a name it swaps that
// copy back in: the current database is KEPT under a snapshot name of its own
// (never dropped), in one transaction (`restoreSnapshot`,
// @nodal-agents/db/snapshots — the module the migration path uses too).
//
// It refuses while Nodal runs: a swap needs no session on either database, and
// a running stack holds both the database and its own idea of what is in it.
// It starts the embedded cluster itself, the way `up` does (same binaries
// check, same password start), and stops it once done.

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readConfig, writeConfig, CONFIG_FILE, PG_DATA_DIR } from '../lib/config.ts';
import { livePostmasterPid, startEmbeddedPostgres } from '../lib/postgres.ts';
import { finishPasswordChange, startWithPassword } from '../lib/pg-password.ts';
import { buildDatabaseUrl } from '../lib/env.ts';
import { isPidAlive, readPids } from '../lib/processes.ts';
import { getInstalledVersion } from '../lib/version.ts';
import { ensureDatabaseBinaries } from './up.ts';
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

/** What is running out of this home, as observed; empty when nothing is. */
function runningNow(): string[] {
  const seen: string[] = [];
  const postmaster = livePostmasterPid(PG_DATA_DIR);
  if (postmaster !== null) seen.push(`postgres pid ${postmaster}`);
  const pids = readPids();
  for (const [label, pid] of [
    ['runner', pids?.runner],
    ['web', pids?.web],
  ] as const) {
    if (pid !== undefined && isPidAlive(pid)) seen.push(`${label} pid ${pid}`);
  }
  return seen;
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
  const running = runningNow();
  if (running.length > 0) {
    throw new Error(
      `Nodal-Agents is running out of this home (${running.join(', ')}).\n` +
        '  A copy can only be swapped back while nothing uses the database. Stop it first:\n\n' +
        '    nodal-agents down\n\n' +
        '  Nothing was changed.',
    );
  }

  const config = readConfig();
  if (config === null || !existsSync(join(PG_DATA_DIR, 'PG_VERSION'))) {
    throw new Error(
      `There is no Nodal-Agents database in this home (${config === null ? `no ${CONFIG_FILE}` : `no cluster in ${PG_DATA_DIR}`}): nothing to roll back.`,
    );
  }

  await ensureDatabaseBinaries();
  const started = await startWithPassword(config, {
    start: (password) => startEmbeddedPostgres(undefined, config.ports.postgres, password),
    save: (next) => writeConfig(next),
    mint: () => randomBytes(24).toString('base64url'),
  });
  const pg = started.pg;
  try {
    const finished = await finishPasswordChange(started, {
      save: (next) => writeConfig(next),
      warn: (message) => console.warn(chalk.yellow(message.replace(/^/gm, '  '))),
    });
    const databaseUrl = buildDatabaseUrl(finished.config.ports.postgres, finished.password);
    const stateFiles = homeStateFiles();
    const keep = finished.config.snapshots?.keep ?? DEFAULT_SNAPSHOTS_KEPT;

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
    const current = await readSchemaState(databaseUrl, { patchVectorAsText: !pg.vectorAvailable });
    const openedBy = await readOpenedBy(databaseUrl);
    const recorded = openedBy !== null && openedBy !== 'unreadable' ? openedBy : null;
    const result = await restoreSnapshot(databaseUrl, opts.name, {
      at: new Date(),
      madeBy: programVersion,
      stateFiles,
      // The current database may be newer than this program (the usual reason
      // to roll back): its newest migration is then named by its own record.
      currentLastMigration: current.lastApplied?.tag ?? recorded?.lastMigration ?? null,
      currentOpenedBy: recorded?.version ?? null,
    });
    const after = await readSchemaState(databaseUrl, { patchVectorAsText: !pg.vectorAvailable });

    const restored = result.restored.meta;
    console.log(chalk.green(`✓ The database is now the copy ${result.restored.name}.`));
    console.log(
      `  It was taken ${restored?.at ?? '(unknown time)'}; its schema goes up to ${restored?.lastMigration ?? '(no migration)'}.`,
    );
    console.log(
      `  The database it replaced is kept as ${result.replaced.name} ` +
        `(${formatBytes(result.replaced.sizeBytes)}): \`nodal-agents rollback ${result.replaced.name}\` swaps it back.`,
    );
    for (const path of result.putBack) {
      console.log(`  ${path} was missing and was put back from the copy.`);
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
    if (after.ahead.length > 0 || after.pending.length > 0) {
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
  } finally {
    await pg.stop();
  }
}
