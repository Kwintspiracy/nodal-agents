// migration-order.mjs — a journal every published install can still apply.
//
// Drizzle's migrator applies only the journal entries whose `when` is later
// than the newest one a database has applied (packages/db/src/migrate.ts). An
// install of the last release has applied every migration that release
// shipped. So a migration added AFTER the release must carry a `when` later
// than all of them; one that does not is skipped on every published install,
// whose next `up` then finds the gap and refuses to start (#1120).
//
// The reference is the journal of the last published release (`v*` tag), not
// `main`: `main` may hold migrations not yet published, which are still free
// to be reordered.
//
// Two rules, both read off the two journals:
//   1. every entry the release shipped is still in the journal, with the same
//      `when` (a published `when` is already in installs' history: changing it
//      makes the database "newer than the program" for every one of them);
//   2. every entry the release did not ship has a `when` later than every
//      entry it shipped.

import { compareVersions } from '../../packages/shared/src/version-compare.ts';

/**
 * @typedef {{ idx: number, when: number, tag: string }} JournalEntry
 * @typedef {{ tag: string, rule: 'released-entry-changed' | 'released-entry-removed' | 'not-after-release', when: number, mustExceed?: number, released?: number, message: string }} OrderViolation
 */

/**
 * @param {{ tag: string, entries: JournalEntry[] }} release the journal at the release tag
 * @param {JournalEntry[]} current the journal being checked
 * @returns {OrderViolation[]}
 */
export function migrationOrderViolations(release, current) {
  const shipped = new Map(release.entries.map((e) => [e.tag, e]));
  const byTag = new Map(current.map((e) => [e.tag, e]));
  const newestShipped = Math.max(...release.entries.map((e) => Number(e.when)));
  /** @type {OrderViolation[]} */
  const out = [];

  for (const e of release.entries) {
    const now = byTag.get(e.tag);
    if (now === undefined) {
      out.push({
        tag: e.tag,
        rule: 'released-entry-removed',
        when: e.when,
        message:
          `${e.tag} shipped in ${release.tag} and is no longer in the journal: every install of ` +
          `${release.tag} has it applied. Put it back.`,
      });
    } else if (Number(now.when) !== Number(e.when)) {
      out.push({
        tag: e.tag,
        rule: 'released-entry-changed',
        when: now.when,
        released: e.when,
        message:
          `${e.tag} shipped in ${release.tag} with "when": ${e.when}; the journal now says ` +
          `${now.when}. A published "when" is in every install's history: restore ${e.when}.`,
      });
    }
  }

  for (const e of current) {
    if (shipped.has(e.tag)) continue;
    if (Number(e.when) <= newestShipped) {
      out.push({
        tag: e.tag,
        rule: 'not-after-release',
        when: e.when,
        mustExceed: newestShipped,
        message:
          `${e.tag} is not in ${release.tag} and its "when" (${e.when}) is not later than the ` +
          `newest migration ${release.tag} shipped (${newestShipped}): every ${release.tag} install ` +
          `would skip it. Renumber it after the last one and give it a "when" greater than ${newestShipped}.`,
      });
    }
  }
  return out;
}

/**
 * The newest `v*` tag by version order, from `git tag` output (one per line),
 * ordered by THE version rule of the code base
 * (packages/shared/src/version-compare.ts). Pre-release tags count: a
 * published pre-release has installs too.
 * @param {string} tagList
 * @returns {string | null}
 */
export function newestReleaseTag(tagList) {
  const tags = tagList
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => /^v\d/.test(t) && compareVersions(t, t) !== null);
  if (tags.length === 0) return null;
  return tags.reduce((best, t) => (compareVersions(t, best) === 1 ? t : best));
}
