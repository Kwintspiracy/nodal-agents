// schema-messages.ts — what the CLI says when the database's schema cannot
// move, or must not be opened.
//
// Written apart from `up.ts` for the reason `migrationGapRefusal` is: this is
// the only thing the person will see, and each sentence names the command
// that gets them out. The facts come from `@nodal-agents/db` (typed errors
// that carry them); the words and the commands are the CLI's.

import type { DatabaseNewerThanProgramError } from '@nodal-agents/db/schema-state';
import { formatBytes, type Snapshot, type SnapshotError } from '@nodal-agents/db/snapshots';

/** The database was migrated by a newer program: refused, with the way out. */
export function databaseNewerRefusal(
  err: DatabaseNewerThanProgramError,
  programVersion: string,
): string {
  const newest = new Date(Math.max(...err.ahead)).toISOString();
  const who =
    err.openedBy === null
      ? 'a newer version of Nodal-Agents (one from before versions were recorded, so it is not named)'
      : err.openedBy === 'unreadable'
        ? 'a newer version of Nodal-Agents (its record in app_settings is unreadable)'
        : `Nodal-Agents ${err.openedBy.version}` +
          (err.openedBy.lastMigration ? ` (newest migration ${err.openedBy.lastMigration})` : '');
  const install =
    err.openedBy !== null && err.openedBy !== 'unreadable'
      ? `    npm install -g nodal-agents@${err.openedBy.version}`
      : '    npm install -g nodal-agents@latest';
  return [
    `This database was last migrated by ${who}.`,
    `It holds ${err.ahead.length} migration${err.ahead.length === 1 ? '' : 's'} later than any ` +
      `this program (${programVersion}, newest migration ${err.programLastMigration ?? 'none'}) ` +
      `knows, the newest applied at ${newest}.`,
    '',
    '  This program would run on a schema it does not know and fail query by query,',
    '  so it will not open the database. Nothing was changed.',
    '',
    '  Either start it with the version that migrated it:',
    '',
    install,
    '',
    '  or go back to the copy taken before it was migrated (lists them, then swaps one back):',
    '',
    '    nodal-agents rollback',
  ].join('\n');
}

/**
 * History rows no journal entry claims, older than the newest one: what a
 * development branch leaves once its migration is renumbered or dropped. Not
 * "newer", not repaired, not rewritten: said, on one line, at each start.
 */
export function unclaimedHistoryNotice(unclaimed: readonly number[]): string {
  const one = unclaimed.length === 1;
  const dates = unclaimed.map((w) => new Date(w).toISOString()).join(', ');
  return (
    `${unclaimed.length} applied migration${one ? '' : 's'} in the database's history ` +
    `${one ? 'is' : 'are'} in no journal of this program and older than its newest migration ` +
    `(applied at ${dates}): ignored, as the migrator ignores ${one ? 'it' : 'them'}.`
  );
}

/** The copy could not be made, so the schema did not move. */
export function snapshotRefusal(err: SnapshotError): string {
  return [
    'The database was NOT migrated: a copy of it is taken before every migration, and this',
    'one could not be made.',
    '',
    `  ${err.message}`,
    '',
    '  Nothing was changed. Start again once that is fixed.',
  ].join('\n');
}

/** The migration itself failed; the copy is named, with the command that puts it back. */
export function migrationFailure(cause: string, snapshot: Snapshot | null): string {
  return [
    `The migration failed: ${cause}`,
    ...(snapshot
      ? [
          '',
          `  A copy of the database taken just before is kept as ${snapshot.name} ` +
            `(${formatBytes(snapshot.sizeBytes)}).`,
          '  To put it back:',
          '',
          `    nodal-agents rollback ${snapshot.name}`,
        ]
      : []),
  ].join('\n');
}
