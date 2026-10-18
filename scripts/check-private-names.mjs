#!/usr/bin/env node
// check-private-names.mjs — does what a push, a PR or a pack ADDS hold a private name?
//
// The names come from a list kept OUTSIDE the repository (see lib/private-names.mjs):
// the file at NODAL_PRIVATE_NAMES (default `private-names.txt` in Nodal's home folder, which NODALAI_HOME moves), or, for a
// CI secret, the list itself in NODAL_PRIVATE_NAMES_CONTENT. One name per line, `#`
// for comments. A name is matched ignoring case, whitespace (line breaks too),
// dashes and underscores. A hit prints `file:line` and the entry's line number in
// the list; every printed string goes through `mask`, so a name never appears.
//
// Targets (any number):
//   --git-range <base>...<head>  the NET change from the merge-base of the two:
//                                the paths it adds or renames to (every segment,
//                                gitlinks included), the lines it adds, and every
//                                commit message in `base..head` (merges included)
//   --git-staged                 the same, for the index
//   <directory>                  a pack: every file and folder name, and the text
//                                of every file
//
// What this does NOT see, on purpose: a name added by an intermediate commit and
// removed again before `head` (the net change never holds it; it stays in the
// history that was pushed), the content of binary files, and a name that a change
// CREATES by deleting a separator-only line (a blank line, a rule) between two
// halves already present: no added line holds any of its letters.
//
// Never silent about what it did not read: a binary file, or a text file above
// MAX_TEXT bytes, is listed as `not read: <path> (binary|size)` and counted. That
// listing does not fail the check (exit stays 0): it is the information.
//
// Exit: 0 clean (or no list configured: said), 1 a hit, 2 the check could not run
// (git failing, a missing directory, a usage error). 2 is never reported as a hit.

import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import {
  entriesInPath,
  formatHit,
  mask,
  resolveList,
  scanLines,
  scanText,
} from './lib/private-names.mjs';

const MAX_TEXT = 8 * 1024 * 1024;

const git = (args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Lines of a git command's output, as they arrive (a big diff is never held whole). */
function gitLines(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', onLine);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
    });
  });
}

/** Paths a net change adds or renames to: `--name-status -z` records. */
function addedPaths(diffArgs) {
  const tokens = git(['diff', '--name-status', '-z', '-M', ...diffArgs]).split('\0');
  const paths = [];
  for (let i = 0; i + 1 < tokens.length; ) {
    const status = tokens[i];
    if (!status) break;
    if (status[0] === 'R' || status[0] === 'C') {
      paths.push(tokens[i + 2]);
      i += 3;
    } else {
      if (status[0] !== 'D') paths.push(tokens[i + 1]);
      i += 2;
    }
  }
  return paths;
}

/**
 * One streaming pass over `git diff -U1`. Per hunk, the added lines are scanned
 * together with the unchanged line on each side, so a name split between an
 * unchanged line and an added one is seen; a name wholly inside unchanged lines is
 * not a hit (it is not part of what the change adds). A binary or oversized file is
 * reported unread.
 */
async function scanNetDiff(diffArgs, names, report) {
  let file = null;
  let inHeader = false;
  let hunk = [];
  let fileHits = [];
  let bytes = 0;
  let oversize = false;
  let next = 0;

  const endHunk = () => {
    if (hunk.length > 0) fileHits.push(...scanLines(hunk, names));
    hunk = [];
  };
  const flush = () => {
    endHunk();
    if (file !== null) {
      if (oversize) report.unread.push({ where: file, why: 'size' });
      else for (const h of fileHits) report.hits.push({ where: file, ...h });
    }
    file = null;
    fileHits = [];
    bytes = 0;
    oversize = false;
  };

  await gitLines(['diff', '-U1', '--no-color', '--no-ext-diff', '-M', ...diffArgs], (raw) => {
    if (raw.startsWith('diff --git ')) {
      flush();
      inHeader = true;
    } else if (inHeader && raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').replace(/^"|"$/g, '');
      if (file === '/dev/null') file = null;
    } else if (inHeader && raw.startsWith('Binary files ')) {
      const m = / and b\/(.*) differ$/.exec(raw);
      if (m) report.unread.push({ where: m[1], why: 'binary' });
    } else if (raw.startsWith('@@')) {
      endHunk();
      inHeader = false;
      next = Number(/\+(\d+)/.exec(raw)?.[1] ?? 1);
    } else if (!inHeader && file !== null && !oversize && (raw[0] === '+' || raw[0] === ' ')) {
      const text = raw.slice(1);
      bytes += text.length + 1;
      if (bytes > MAX_TEXT) {
        oversize = true;
        hunk = [];
      } else {
        hunk.push({ line: next, text, added: raw[0] === '+' });
      }
      next++;
    }
  });
  flush();
}

/** `<base>...<head>` (or `..`): the net change and the messages of the range. */
async function scanRange(spec, names, report) {
  const m = /^(.+?)\.{2,3}(.+)$/.exec(spec);
  if (!m) throw new Error(`--git-range needs <base>...<head>, got "${spec}"`);
  const [, base, head] = m;
  const net = [`${base}...${head}`];
  for (const p of addedPaths(net)) {
    const entries = entriesInPath(p, names);
    if (entries.length > 0) report.hits.push({ where: p, line: 0, entries });
  }
  await scanNetDiff(net, names, report);
  const log = git(['log', '--format=%x01%h%n%B', `${base}..${head}`]);
  for (const block of log.split('\u0001').filter(Boolean)) {
    const [sha, ...body] = block.split('\n');
    for (const h of scanText(body.join('\n'), names)) {
      report.hits.push({ where: `commit ${sha} message`, ...h });
    }
  }
}

async function scanStaged(names, report) {
  for (const p of addedPaths(['--cached'])) {
    const entries = entriesInPath(p, names);
    if (entries.length > 0) report.hits.push({ where: p, line: 0, entries });
  }
  await scanNetDiff(['--cached'], names, report);
}

function isBinary(path, size) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(8000, size));
    readSync(fd, head, 0, head.length, 0);
    return head.includes(0);
  } finally {
    closeSync(fd);
  }
}

function scanDirectory(root, names, report) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`directory not found: ${root}`);
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const shown = join(root, relative(root, path));
      const inName = entriesInPath(entry.name, names);
      if (inName.length > 0) report.hits.push({ where: shown, line: 0, entries: inName });
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        const size = statSync(path).size;
        if (size > MAX_TEXT) report.unread.push({ where: shown, why: 'size' });
        else if (isBinary(path, size)) report.unread.push({ where: shown, why: 'binary' });
        else {
          for (const h of scanText(readFileSync(path, 'utf8'), names)) {
            report.hits.push({ where: shown, ...h });
          }
        }
      }
    }
  };
  walk(root);
}

async function main(argv, out) {
  const { names, source } = resolveList();
  if (names === null) {
    out(
      `check-private-names: no private-names list configured (${source} is absent); nothing was checked.`,
    );
    return { code: 0, names: [] };
  }
  if (names.length === 0) {
    out(
      `check-private-names: the private-names list (${source}) has no entry; nothing was checked.`,
    );
    return { code: 0, names };
  }

  const report = { hits: [], unread: [] };
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--git-staged') {
      await scanStaged(names, report);
      targets.push(arg);
    } else if (arg === '--git-range') {
      const spec = argv[++i];
      if (!spec) throw new Error('--git-range needs <base>...<head>');
      await scanRange(spec, names, report);
      targets.push(`${arg} ${spec}`);
    } else {
      scanDirectory(arg, names, report);
      targets.push(arg);
    }
  }
  if (targets.length === 0) {
    throw new Error('give --git-range <base>...<head>, --git-staged or a directory');
  }

  for (const u of report.unread) out(`not read: ${u.where} (${u.why})`);
  for (const hit of report.hits) out(formatHit(hit, names));
  const unread =
    report.unread.length > 0
      ? `; ${report.unread.length} file(s) not read (binary, or over ${MAX_TEXT / 1024 / 1024} MB)`
      : '';
  if (report.hits.length > 0) {
    out(
      `check-private-names: ${report.hits.length} hit(s) in ${targets.join(', ')}${unread}. The names are in ${source}; they are not printed.`,
    );
    return { code: 1, names };
  }
  out(
    `check-private-names: ${names.length} name(s) checked in ${targets.join(', ')}, no hit${unread}.`,
  );
  return { code: 0, names };
}

const lines = [];
let names = [];
try {
  const result = await main(process.argv.slice(2), (line) => lines.push(line));
  names = result.names;
  for (const line of lines) console.log(mask(line, names));
  process.exit(result.code);
} catch (err) {
  try {
    names = resolveList().names ?? [];
  } catch {
    /* the list itself is unreadable: nothing to mask with */
  }
  console.error(
    `check-private-names: could not run the check: ${mask(String(err.message), names)}`,
  );
  process.exit(2);
}
