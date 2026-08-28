// migration-pack-filter.mjs — what of packages/db/migrations/ ships in the pack.
//
// The migrations folder holds two very different kinds of file:
//
//   *.sql                    the migrations themselves — 87 files, 274 kB total
//   meta/_journal.json       the ordered index the migrator walks
//   meta/NNNN_snapshot.json  drizzle-kit's schema snapshots — 12 files, 1.3 MB
//
// Only the first two are needed to APPLY migrations. The snapshots exist so
// `drizzle-kit generate` can diff the current schema against the last known
// one and emit the next migration; that is a development-time concern and
// never runs from an install.
//
// Verified in drizzle-orm 0.45.2's own migrator (migrator.cjs), which reads
// exactly one file out of meta/:
//
//     const journalPath = `${migrationFolderTo}/meta/_journal.json`;
//
// packages/db/src/migrate.ts carried a comment saying Drizzle "needs the meta/
// subfolder + journal file" — true of the journal, false of the snapshots, and
// the reason 1.3 MB of dead weight shipped in every release. That is five
// times the weight of every migration combined.

/** Files under migrations/ that never ship. */
const EXCLUDED_PATTERN = /^meta[/\\]\d+_snapshot\.json$/;

/**
 * Should this file, given as a path RELATIVE to packages/db/migrations/, be
 * copied into the pack?
 *
 * Deliberately an allow-by-default with one narrow exclusion: a new kind of
 * file appearing under migrations/ ships rather than being silently dropped,
 * which is the safer direction to fail for something the boot sequence depends
 * on.
 */
export function shouldPackMigrationFile(relativePath) {
  return !EXCLUDED_PATTERN.test(relativePath.replace(/\\/g, '/').replace(/^\.\//, ''));
}
