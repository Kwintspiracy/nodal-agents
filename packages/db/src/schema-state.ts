// schema-state.ts — where a database's schema stands against THIS program's
// journal, and who last opened it.
//
// Three answers come out of one reading of `drizzle.__drizzle_migrations`
// against `meta/_journal.json` (by `when`, never by hash: see migrate.ts):
//
//   - PENDING: the journal entries later than the newest one applied. They are
//     what Drizzle's migrator will apply (it only looks at the newest row).
//   - GAPS: journal entries OLDER than the newest one applied that the history
//     does not hold. The migrator skips them for good (#298).
//   - AHEAD: history rows LATER than the newest entry of this program's
//     journal. The database was migrated by a program that knows migrations
//     this one does not: this program is OLDER than the database, and running
//     on it would fail later, query by query, on a schema it does not know
//     (ACC-10). That, and only that, is "newer than the program".
//   - UNCLAIMED: history rows no journal entry claims, NOT later than the
//     journal's newest entry. They are what a development branch leaves once
//     its migration is renumbered or dropped before release. The database is
//     not newer; the migrator ignores them (it compares only against the newest
//     row) and so does the gap check. They are reported, never acted on.
//
// Two lists, never one: a reader that treated an unclaimed row as "ahead"
// refused to start installs that were not newer than the program.
//
// WHO OPENED IT LAST. Each start that migrated (or found nothing to migrate)
// records its version in `app_settings` under `schema_opened_by`, so that an
// older program refusing the database can NAME the version it needs. The
// refusal itself never depends on that record: it reads the history against
// the journal, which every install has. An install that never recorded a
// version (every install before this one) is refused or accepted by the same
// rule, and its message says the version is not known; the first start that
// accepts it records one.

import postgres from 'postgres';
import {
  appliedMigrationTimes,
  gapsBetween,
  readProgramJournal,
  type JournalEntry,
  type MigrationGap,
  type RunMigrationsOptions,
} from './migrate.ts';

/** The `app_settings` key holding the version that last opened the database. */
export const SCHEMA_OPENED_BY_SETTING = 'schema_opened_by';

/** What the record says. */
export interface OpenedBy {
  /** The Nodal-Agents version (its `package.json`). */
  readonly version: string;
  /** The tag of the newest migration applied when it was recorded. */
  readonly lastMigration: string | null;
  /** ISO time of the record. */
  readonly at: string;
}

/** The record, `null` when none was ever written, `'unreadable'` when it does not parse. */
export type OpenedByRecord = OpenedBy | null | 'unreadable';

export interface SchemaState {
  readonly journal: readonly JournalEntry[];
  /** `created_at` of every applied migration, `null` when there is no history table. */
  readonly applied: readonly number[] | null;
  /** The newest applied migration, and its tag when this journal knows it. */
  readonly lastApplied: { readonly when: number; readonly tag: string | null } | null;
  /** The newest applied migration this journal claims (what a copy is named after). */
  readonly lastClaimed: { readonly when: number; readonly tag: string } | null;
  readonly pending: readonly JournalEntry[];
  readonly gaps: readonly MigrationGap[];
  /** Applied `created_at` values LATER than the journal's newest entry, oldest first. */
  readonly ahead: readonly number[];
  /** Applied `created_at` values no entry claims, not later than the newest one, oldest first. */
  readonly unclaimed: readonly number[];
}

/**
 * The state of a schema whose history is `applied`, read against `journal`.
 * PURE: the rule is tested without a database.
 */
export function schemaStateOf(
  journal: readonly JournalEntry[],
  applied: readonly number[] | null,
): SchemaState {
  if (applied === null || applied.length === 0) {
    return {
      journal,
      applied,
      lastApplied: null,
      lastClaimed: null,
      pending: journal,
      gaps: [],
      ahead: [],
      unclaimed: [],
    };
  }
  const newest = Math.max(...applied);
  const journalNewest =
    journal.length > 0 ? Math.max(...journal.map((e) => Number(e.when))) : -Infinity;
  const known = new Set(journal.map((e) => Number(e.when)));
  const appliedSet = new Set(applied.map((w) => Number(w)));
  const notInJournal = [...new Set(applied.filter((w) => !known.has(w)))].sort((a, b) => a - b);
  const lastClaimed = journal
    .filter((e) => appliedSet.has(Number(e.when)))
    .reduce<JournalEntry | null>(
      (best, e) => (best === null || e.when > best.when ? e : best),
      null,
    );
  return {
    journal,
    applied,
    lastApplied: { when: newest, tag: journal.find((e) => e.when === newest)?.tag ?? null },
    lastClaimed: lastClaimed === null ? null : { when: lastClaimed.when, tag: lastClaimed.tag },
    pending: journal.filter((e) => e.when > newest),
    // Only BELOW the newest applied: an entry above it is pending, not a gap.
    gaps: gapsBetween(
      journal.filter((e) => e.when < newest),
      applied,
    ),
    ahead: notInJournal.filter((w) => w > journalNewest),
    unclaimed: notInJournal.filter((w) => w <= journalNewest),
  };
}

/** The database's schema against this program's journal. */
export async function readSchemaState(
  connectionString: string,
  opts: RunMigrationsOptions = {},
): Promise<SchemaState> {
  const journal = readProgramJournal(opts);
  const applied = await appliedMigrationTimes(connectionString);
  return schemaStateOf(journal, applied);
}

function parseOpenedBy(value: string): OpenedByRecord {
  try {
    const v = JSON.parse(value) as Partial<Record<keyof OpenedBy, unknown>>;
    if (typeof v.version !== 'string' || v.version === '') return 'unreadable';
    return {
      version: v.version,
      lastMigration: typeof v.lastMigration === 'string' ? v.lastMigration : null,
      at: typeof v.at === 'string' ? v.at : '',
    };
  } catch {
    return 'unreadable';
  }
}

/** The version that last opened the database, as recorded by `recordOpenedBy`. */
export async function readOpenedBy(connectionString: string): Promise<OpenedByRecord> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const [table] = await sql<{ ok: boolean }[]>`
      SELECT to_regclass('public.app_settings') IS NOT NULL AS ok`;
    if (table?.ok !== true) return null;
    const [row] = await sql<{ value: string }[]>`
      SELECT value FROM app_settings WHERE key = ${SCHEMA_OPENED_BY_SETTING}`;
    return row === undefined ? null : parseOpenedBy(row.value);
  } finally {
    await sql.end();
  }
}

/** Record that `version` opened the database, its newest migration being `lastMigration`. */
export async function recordOpenedBy(
  connectionString: string,
  record: { version: string; lastMigration: string | null; at?: Date },
): Promise<void> {
  const value = JSON.stringify({
    version: record.version,
    lastMigration: record.lastMigration,
    at: (record.at ?? new Date()).toISOString(),
  });
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${SCHEMA_OPENED_BY_SETTING}, ${value}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  } finally {
    await sql.end();
  }
}

/**
 * The database was migrated by a program newer than this one. Carries what a
 * message needs; the CLI words it (it knows the commands to name).
 */
export class DatabaseNewerThanProgramError extends Error {
  readonly code = 'DATABASE_NEWER_THAN_PROGRAM';
  constructor(
    /** Applied `created_at` values later than the newest entry of this program's journal. */
    readonly ahead: readonly number[],
    /** Who last opened the database, when recorded. */
    readonly openedBy: OpenedByRecord,
    /** The newest migration this program knows. */
    readonly programLastMigration: string | null,
  ) {
    const who =
      openedBy === null
        ? 'a newer version (it did not record which)'
        : openedBy === 'unreadable'
          ? 'a newer version (its record in app_settings is unreadable)'
          : `version ${openedBy.version}`;
    super(
      `DATABASE_NEWER_THAN_PROGRAM: the database holds ${ahead.length} migration` +
        `${ahead.length === 1 ? '' : 's'} later than the newest one this program's journal has ` +
        `(newest applied at ${new Date(Math.max(...ahead)).toISOString()}); ` +
        `it was last opened by ${who}.`,
    );
    this.name = 'DatabaseNewerThanProgramError';
  }
}

/**
 * Throw `DatabaseNewerThanProgramError` when the database holds a migration
 * later than the newest one this program knows (rows that are merely
 * unclaimed do not count: see the header). For a program that opens the database without
 * migrating it (the MCP server); `migrateDatabase` makes the same check first.
 */
export async function assertProgramKnowsDatabase(
  connectionString: string,
  opts: RunMigrationsOptions = {},
): Promise<SchemaState> {
  const state = await readSchemaState(connectionString, opts);
  if (state.ahead.length > 0) {
    throw new DatabaseNewerThanProgramError(
      state.ahead,
      await readOpenedBy(connectionString),
      state.journal.at(-1)?.tag ?? null,
    );
  }
  return state;
}
