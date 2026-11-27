// safe-migrate.ts — THE function through which a database's schema moves.
//
// THE RULE. The schema never moves without a copy the person can go back to,
// and a program never opens a database it is older than. Both are decided
// HERE, once, for every path that migrates: `up`, `up --dev`, `up
// --repair-migrations`, and `update` (which restarts through `up`). Nothing
// else in the product calls the migrator; an architecture test says so.
//
// In order, on every start:
//
//   1. Read the schema against this program's journal (schema-state.ts).
//   2. A migration in the history that the journal does not have: the database
//      is newer than this program. Refused, before anything is written.
//   3. A migration the migrator skipped (#298) and no repair asked: refused,
//      before anything is written (nothing would fix it on the way).
//   4. Something is about to change the schema (a pending migration, or a
//      repair of skipped ones) and the database holds rows: a COPY is made
//      first, inside the cluster, with the state files beside it
//      (snapshots.ts). If it cannot be made (another session connected, not
//      enough disk, no right to create a database), NOTHING is migrated and
//      the error says why (invariant #4: never migrate without the copy).
//      Nothing pending, or a fresh database: no copy.
//   5. Once that copy is complete, and only then, copies beyond the number
//      kept are dropped (`snapshots.keep`, default 2).
//   6. Migrate; repair the skipped ones when asked; read the gaps again.
//   7. Record the version that opened the database.

import {
  repairMigrations,
  runMigrations,
  type MigrationGap,
  type RunMigrationsOptions,
} from './migrate.ts';
import {
  DatabaseNewerThanProgramError,
  readOpenedBy,
  readSchemaState,
  recordOpenedBy,
  type SchemaState,
} from './schema-state.ts';
import {
  createSnapshot,
  databaseHoldsRows,
  pruneSnapshots,
  type Snapshot,
  type SnapshotStateFiles,
} from './snapshots.ts';

export interface MigrateDatabaseOptions extends RunMigrationsOptions {
  /** Apply the migrations the migrator skipped (`up --repair-migrations`). */
  readonly repair: boolean;
  /** This program's version, recorded as the one that opened the database. */
  readonly programVersion: string;
  /** How many complete copies to keep. */
  readonly keep: number;
  /** Free bytes where the cluster writes. */
  readonly freeBytes: () => number | Promise<number>;
  readonly stateFiles: SnapshotStateFiles;
  readonly now?: () => Date;
  /** What is being done now, for a spinner. */
  readonly onStep?: (text: string) => void;
}

export interface MigrateDatabaseResult {
  /** The copy taken before the schema moved, or `null` when none was needed. */
  readonly snapshot: Snapshot | null;
  /** Copies dropped once the new one was complete. */
  readonly pruned: readonly string[];
  /** Tags the migrator applied. */
  readonly applied: readonly string[];
  /** Tags the repair applied. */
  readonly repaired: readonly string[];
}

/** Migrations the journal announces and the database never got. */
export class MigrationGapError extends Error {
  readonly code = 'MIGRATION_GAPS';
  constructor(readonly gaps: readonly MigrationGap[]) {
    super(
      `MIGRATION_GAPS: the database is missing ${gaps.length} migration` +
        `${gaps.length === 1 ? '' : 's'} the journal announces: ${gaps.map((g) => g.tag).join(', ')}`,
    );
    this.name = 'MigrationGapError';
  }
}

/**
 * An error and every cause under it, joined: Drizzle wraps the server's error
 * ("Failed query: …") and the reason ("division by zero") is in its cause.
 */
export function errorChain(err: unknown): string {
  const parts: string[] = [];
  let at: unknown = err;
  for (let depth = 0; at !== undefined && at !== null && depth < 5; depth++) {
    const message = at instanceof Error ? at.message : String(at);
    if (message !== '' && !parts.includes(message)) parts.push(message);
    at = at instanceof Error ? at.cause : undefined;
  }
  return parts.join(': ');
}

/** The migration itself failed; the copy taken before it is named. */
export class MigrationFailedError extends Error {
  readonly code = 'MIGRATION_FAILED';
  constructor(
    readonly snapshot: Snapshot | null,
    cause: unknown,
  ) {
    super(
      `MIGRATION_FAILED: ${errorChain(cause)}` +
        (snapshot ? ` (the copy taken just before is ${snapshot.name})` : ''),
      { cause },
    );
    this.name = 'MigrationFailedError';
  }
}

function newestTag(state: SchemaState): string | null {
  return state.lastApplied?.tag ?? null;
}

export async function migrateDatabase(
  connectionString: string,
  opts: MigrateDatabaseOptions,
): Promise<MigrateDatabaseResult> {
  const now = opts.now ?? ((): Date => new Date());
  const migrateOpts: RunMigrationsOptions = {
    ...(opts.patchVectorAsText !== undefined ? { patchVectorAsText: opts.patchVectorAsText } : {}),
    ...(opts.migrationsFolder !== undefined ? { migrationsFolder: opts.migrationsFolder } : {}),
  };

  // 1-3. Read, and refuse what no migration may proceed on.
  opts.onStep?.('Reading the database schema…');
  const before = await readSchemaState(connectionString, migrateOpts);
  const openedBy = await readOpenedBy(connectionString);
  if (before.unknown.length > 0) {
    throw new DatabaseNewerThanProgramError(
      before.unknown,
      openedBy,
      before.journal.at(-1)?.tag ?? null,
    );
  }
  if (before.gaps.length > 0 && !opts.repair) throw new MigrationGapError(before.gaps);

  // 4-5. The copy, when the schema is about to move over rows.
  const willChange = before.pending.length > 0 || (opts.repair && before.gaps.length > 0);
  let snapshot: Snapshot | null = null;
  let pruned: string[] = [];
  if (willChange && (await databaseHoldsRows(connectionString))) {
    opts.onStep?.('Copying the database before migrating…');
    snapshot = await createSnapshot(connectionString, {
      at: now(),
      kind: 'before-migration',
      lastMigration: newestTag(before),
      lastOpenedBy: openedBy !== null && openedBy !== 'unreadable' ? openedBy.version : null,
      madeBy: opts.programVersion,
      stateFiles: opts.stateFiles,
      freeBytes: opts.freeBytes,
    });
    pruned = await pruneSnapshots(connectionString, {
      keep: opts.keep,
      stateFilesDir: opts.stateFiles.dir,
    });
  }

  // 6. Migrate, repair, read again.
  let repaired: MigrationGap[] = [];
  try {
    if (before.pending.length > 0) {
      opts.onStep?.(
        `Applying ${before.pending.length} migration${before.pending.length === 1 ? '' : 's'}…`,
      );
      await runMigrations(connectionString, migrateOpts);
    }
    if (opts.repair && before.gaps.length > 0) {
      opts.onStep?.(
        `Repairing ${before.gaps.length} skipped migration${before.gaps.length === 1 ? '' : 's'}…`,
      );
      repaired = await repairMigrations(connectionString, migrateOpts);
    }
  } catch (err) {
    throw new MigrationFailedError(snapshot, err);
  }
  const after = await readSchemaState(connectionString, migrateOpts);
  // Read again, never deduced: a migrator or a repair that returned without
  // throwing does not prove the database is complete.
  if (after.gaps.length > 0) throw new MigrationGapError(after.gaps);
  if (after.pending.length > 0) {
    throw new MigrationFailedError(
      snapshot,
      new Error(
        `the migrator returned with ${after.pending.length} migration(s) still pending: ` +
          after.pending.map((e) => e.tag).join(', '),
      ),
    );
  }

  // 7. Who opened it.
  await recordOpenedBy(connectionString, {
    version: opts.programVersion,
    lastMigration: newestTag(after),
    at: now(),
  });

  return {
    snapshot,
    pruned,
    applied: before.pending.map((e) => e.tag),
    repaired: repaired.map((g) => g.tag),
  };
}
