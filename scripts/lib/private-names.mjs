// private-names.mjs — the matching core of check-private-names.mjs.
//
// A private name (a connector, a person, a machine of one user) must never reach
// the public repository, the pack or a commit message. The list of such names is
// NOT in the repository: a list of secrets kept next to the thing it protects
// would itself publish them. It lives outside the repo, per user (a file), or in
// a CI secret (its content).
//
// Matching ignores case and every whitespace, dash and underscore on BOTH sides —
// line breaks included, so a name cut by a newline is still one name. Nothing
// here ever returns or prints a name: a hit carries the line number of the entry
// in the list, and a printed path goes through `mask` first.
//
// What is looked at: the text of a file as UTF-8, as UTF-16 (both byte orders, at
// both alignments), and the base64 (and base64url) encodings of each name at the
// three byte offsets. File and folder names are compared segment by segment.

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
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

/**
 * `text` without its separators (and, when `fold`, lower-cased), with for each
 * kept character the index it had in `text`.
 */
function compact(text, { fold = true, drop = isSeparator } = {}) {
  const chars = [];
  const at = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (drop(ch)) continue;
    for (const out of fold ? ch.toLowerCase() : ch) {
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
    const written = raw.replace(/#.*/, '').trim();
    const form = normalize(written);
    if (form) names.push({ entry: i + 1, form, written });
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

/** 1-based line of `index` in `text`. */
function lineOf(text, index) {
  let lines = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) lines++;
  return lines + 1;
}

function toHits(byLine) {
  return [...byLine]
    .sort((a, b) => a[0] - b[0])
    .map(([line, set]) => ({ line, entries: [...set].sort((a, b) => a - b) }));
}

function noter() {
  const byLine = new Map();
  const note = (line, entry) => byLine.set(line, new Set([...(byLine.get(line) ?? []), entry]));
  return { byLine, note };
}

/** Hits of a text: `{ line, entries }` per line where a name starts. */
export function scanText(text, names) {
  const { byLine, note } = noter();
  for (const s of findInText(text, names)) note(lineOf(text, s.start), s.entry);
  return toHits(byLine);
}

// ─── Bytes ───────────────────────────────────────────────────────────────────

const CHUNK = 4 * 1024 * 1024;
const OVERLAP = 64 * 1024;

const needlesCache = new WeakMap();

/** Base64 / base64url fragments that a name leaves in an encoded stream, any alignment. */
function base64Needles(names) {
  const cached = needlesCache.get(names);
  if (cached) return cached;
  const needles = [];
  for (const n of names) {
    for (const spelling of new Set([n.form, n.written, n.written.toLowerCase()])) {
      const bytes = Buffer.from(spelling, 'utf8');
      for (let k = 0; k < 3; k++) {
        let s = Buffer.concat([Buffer.alloc(k), bytes])
          .toString('base64')
          .replace(/=+$/, '');
        // The last character of an incomplete group depends on the byte after it.
        if ((k + bytes.length) % 3 !== 0) s = s.slice(0, -1);
        s = s.slice([0, 2, 3][k]);
        if (s.length < 4) continue;
        needles.push({ entry: n.entry, text: s });
        needles.push({ entry: n.entry, text: s.replace(/\+/g, '-').replace(/\//g, '_') });
      }
    }
  }
  needlesCache.set(names, needles);
  return needles;
}

function swapped(chunk, from) {
  const even = chunk.subarray(from, from + ((chunk.length - from) & ~1));
  return Buffer.from(even).swap16().toString('utf16le');
}

/**
 * Hits `{ line, entries }` of the bytes `read(start, length)` serves, `size` bytes
 * in all, taken chunk by chunk (a file of any size, never loaded whole).
 */
export function scanStream(size, read, names) {
  const { byLine, note } = noter();
  const needles = base64Needles(names);
  let newlinesBefore = 0;

  for (let start = 0; start < size; start += CHUNK) {
    const chunk = read(start, Math.min(CHUNK + OVERLAP, size - start));
    const views = [chunk.toString('utf8')];
    if (chunk.includes(0)) {
      views.push(
        chunk.toString('utf16le'),
        chunk.subarray(1).toString('utf16le'),
        swapped(chunk, 0),
        swapped(chunk, 1),
      );
    }
    for (const view of views) {
      for (const s of findInText(view, names)) {
        note(newlinesBefore + lineOf(view, s.start), s.entry);
      }
    }
    if (needles.length > 0) {
      const latin = chunk.toString('latin1');
      const { norm, at } = compact(latin, { fold: false, drop: isWhitespace });
      for (const needle of needles) {
        for (let p = norm.indexOf(needle.text); p >= 0; p = norm.indexOf(needle.text, p + 1)) {
          note(newlinesBefore + lineOf(latin, at[p]), needle.entry);
        }
      }
    }
    const own = chunk.subarray(0, Math.min(CHUNK, chunk.length));
    for (let i = own.indexOf(10); i >= 0; i = own.indexOf(10, i + 1)) newlinesBefore++;
  }
  return toHits(byLine);
}

export function scanBuffer(buf, names) {
  return scanStream(buf.length, (s, l) => buf.subarray(s, s + l), names);
}

/** Hits of a file on disk, read chunk by chunk. */
export function scanFile(path, size, names) {
  const fd = openSync(path, 'r');
  try {
    return scanStream(
      size,
      (start, length) => {
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, start);
        return buf;
      },
      names,
    );
  } finally {
    closeSync(fd);
  }
}

// ─── Reports ─────────────────────────────────────────────────────────────────

/** The report line for a hit: where, and which list entries, never the name. */
export function formatHit(hit, names) {
  const where = mask(hit.where, names);
  const ids = hit.entries.join(', ');
  return hit.line
    ? `${where}:${hit.line}  matches private-names entry ${ids}`
    : `${where}  path matches private-names entry ${ids}`;
}
