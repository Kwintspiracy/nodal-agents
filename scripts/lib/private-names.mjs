// private-names.mjs — the matching core of check-private-names.mjs.
//
// A private name (a connector, a person, a machine of one user) must never reach
// the public repository, the pack or a commit message. The list of such names is
// NOT in the repository: a list of secrets kept next to the thing it protects
// would itself publish them. It lives in a file outside the repo, per user.
//
// Matching ignores case and every space, dash and underscore on BOTH sides, so
// "x printer", "xprinter" and "X_Printer" are one name. Nothing here ever returns
// or prints a name: a hit carries the line number of the entry in the list.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the list is read from: NODAL_PRIVATE_NAMES, else ~/.nodalai/private-names.txt. */
export function listPath(env = process.env, home = homedir()) {
  const fromEnv = env.NODAL_PRIVATE_NAMES?.trim();
  return fromEnv ? fromEnv : join(home, '.nodalai', 'private-names.txt');
}

/** The form compared: lower case, no space, dash or underscore. */
export function normalize(text) {
  return text.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Entries of the list: one per line, `#` starts a comment. `entry` is the line
 * number in the file, the only handle a report may carry.
 */
export function parseList(text) {
  const names = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const form = normalize(raw.replace(/#.*/, ''));
    if (form) names.push({ entry: i + 1, form });
  });
  return names;
}

/** `null` when the list file is absent; otherwise its parsed entries (maybe none). */
export function loadList(path) {
  if (!existsSync(path)) return null;
  return parseList(readFileSync(path, 'utf8'));
}

/** Entry numbers of the names `line` contains. */
export function entriesIn(line, names) {
  const form = normalize(line);
  return names.filter((n) => form.includes(n.form)).map((n) => n.entry);
}

/** Hits of a text: `{ line, entries }` per line that holds a name. */
export function scanText(text, names) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const entries = entriesIn(line, names);
    if (entries.length > 0) hits.push({ line: i + 1, entries });
  });
  return hits;
}

/**
 * Hits among the ADDED lines of a `git diff -U0` output. A hit reports the file
 * and the line in the new version; removed lines are not scanned.
 */
export function scanDiff(diff, names) {
  const hits = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
    } else if (raw.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0) - 1;
    } else if (raw.startsWith('+')) {
      line++;
      const entries = entriesIn(raw.slice(1), names);
      if (entries.length > 0 && file && file !== '/dev/null') {
        hits.push({ where: file, line, entries });
      }
    }
  }
  return hits;
}

/** The report line for a hit: where, and which list entries, never the name. */
export function formatHit(hit) {
  return `${hit.where}:${hit.line}  matches private-names entry ${hit.entries.join(', ')}`;
}
