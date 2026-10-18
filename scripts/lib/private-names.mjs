// private-names.mjs — the matching core of check-private-names.mjs.
//
// A private name (a connector, a person, a machine of one user) must not reach the
// public repository, a pack or a commit message. The list of such names is NOT in
// the repository: a list of secrets kept next to the thing it protects would
// itself publish them. It lives outside the repo, per user (a file), or in a CI
// secret (its content).
//
// Matching ignores case and every whitespace, dash and underscore on BOTH sides,
// line breaks included, so a name cut by a newline is still one name. Nothing here
// returns or prints a name: a hit carries the line number of the entry in the
// list, and every printed string goes through `mask` first.
//
// The one question asked: does what a push, a PR or a pack ADDS contain a name?
// Text is compared as UTF-8; a binary or oversized file is not read, and says so.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the list file is read from: NODAL_PRIVATE_NAMES, else ~/.nodalai/private-names.txt. */
export function listPath(env = process.env, home = homedir()) {
  const fromEnv = env.NODAL_PRIVATE_NAMES?.trim();
  return fromEnv ? fromEnv : join(home, '.nodalai', 'private-names.txt');
}

function isWhitespace(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? c === 32 || (c >= 9 && c <= 13) : /\s/.test(ch);
}

function isSeparator(ch) {
  const c = ch.charCodeAt(0);
  return c === 95 || c === 45 || isWhitespace(ch);
}

/** `text` lower-cased without its separators, and for each kept character its index in `text`. */
function compact(text) {
  const chars = [];
  const at = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isSeparator(ch)) continue;
    for (const out of ch.toLowerCase()) {
      chars.push(out);
      at.push(i);
    }
  }
  return { norm: chars.join(''), at };
}

/** The form compared: lower case, no whitespace, dash or underscore. */
export function normalize(text) {
  return compact(text).norm;
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

/**
 * The list: `NODAL_PRIVATE_NAMES_CONTENT` (the list itself, for a CI secret) wins,
 * else the file at `listPath`. `names` is `null` when neither exists.
 */
export function resolveList(env = process.env, home = homedir()) {
  const content = env.NODAL_PRIVATE_NAMES_CONTENT;
  if (content && content.trim()) {
    return { names: parseList(content), source: 'NODAL_PRIVATE_NAMES_CONTENT' };
  }
  const path = listPath(env, home);
  if (!existsSync(path)) return { names: null, source: path };
  return { names: parseList(readFileSync(path, 'utf8')), source: path };
}

/** Spans of `text` that hold a name: `{ entry, start, end }` over the original text. */
export function findInText(text, names) {
  const { norm, at } = compact(text);
  const found = [];
  for (const n of names) {
    for (let p = norm.indexOf(n.form); p >= 0; p = norm.indexOf(n.form, p + 1)) {
      found.push({ entry: n.entry, start: at[p], end: at[p + n.form.length - 1] + 1 });
    }
  }
  return found;
}

/** `text` with every name replaced by `[private #entry]`: safe to print. */
export function mask(text, names) {
  if (!names || names.length === 0) return text;
  const spans = findInText(text, names).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    if (s.end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, s.start)) + `[private #${s.entry}]`;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/** Entries whose name is in one of the segments of a path (file and folder names). */
export function entriesInPath(path, names) {
  const entries = new Set();
  for (const segment of path.split(/[\\/]/)) {
    for (const s of findInText(segment, names)) entries.add(s.entry);
  }
  return [...entries].sort((a, b) => a - b);
}

/** Hits of `lines` (`[{ line, text }]`, joined by newlines): one `{ line, entries }` per start line. */
export function scanLines(lines, names) {
  const starts = [];
  let text = '';
  for (const l of lines) {
    starts.push(text.length);
    text += `${l.text}\n`;
  }
  const byLine = new Map();
  for (const s of findInText(text, names)) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= s.start) lo = mid;
      else hi = mid - 1;
    }
    const line = lines[lo].line;
    byLine.set(line, new Set([...(byLine.get(line) ?? []), s.entry]));
  }
  return [...byLine]
    .sort((a, b) => a[0] - b[0])
    .map(([line, set]) => ({ line, entries: [...set].sort((a, b) => a - b) }));
}

/** Hits of a whole text (lines numbered from 1). */
export function scanText(text, names) {
  return scanLines(
    text
      .replace(/\r?\n$/, '')
      .split('\n')
      .map((t, i) => ({ line: i + 1, text: t })),
    names,
  );
}

/** The report line for a hit: where, and which list entries, never the name. */
export function formatHit(hit, names) {
  const where = mask(hit.where, names);
  const ids = hit.entries.join(', ');
  return hit.line
    ? `${where}:${hit.line}  matches private-names entry ${ids}`
    : `${where}  path matches private-names entry ${ids}`;
}
