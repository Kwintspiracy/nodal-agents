#!/usr/bin/env node
// check-private-names.mjs — fail when a private name reaches what is published.
//
// The names are read from a list kept OUTSIDE the repository (see
// lib/private-names.mjs): the file at NODAL_PRIVATE_NAMES (default
// ~/.nodalai/private-names.txt), or, for a CI secret, the list itself in
// NODAL_PRIVATE_NAMES_CONTENT. One name per line, `#` for comments. Each name is
// matched ignoring case, whitespace (line breaks too), dashes and underscores, in
// file contents (UTF-8, UTF-16, base64) and in file and folder names. A hit prints
// `file:line` and the line number of the entry in the list; every printed string
// goes through `mask`, so a name never appears, not even in a path.
//
// Targets (any number):
//   --git-staged         the files in the index
//   --git-range <a>..<b> every file version and commit message those commits add;
//                        `<b>` alone scans the whole history of <b>
//   <directory>          every file under it (the pack), names included
//
// No list configured: said on stdout, exit 0. Any hit: exit 1. Usage error or a
// check that could not run (git failing, unreadable file): exit 2, never a hit.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  entriesInPath,
  formatHit,
  mask,
  resolveList,
  scanBuffer,
  scanFile,
  scanText,
} from './lib/private-names.mjs';

const MAX_BUFFER = 1024 * 1024 * 1024;

const git = (args, encoding = 'utf8') =>
  execFileSync('git', args, { encoding, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });

function scanDirectory(root, names, hits) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const shown = relative(root, path) || entry.name;
      const inName = entriesInPath(entry.name, names);
      if (inName.length > 0) hits.push({ where: join(root, shown), line: 0, entries: inName });
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        for (const h of scanFile(path, statSync(path).size, names)) {
          hits.push({ where: join(root, shown), ...h });
        }
      }
    }
  };
  walk(root);
}

/** `[{ blob, path }]` of the entries of `git diff-tree` / `git diff --raw -z` output. */
function parseRaw(out) {
  const tokens = out.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = /^:(\d+) (\d+) \w+ (\w+) \w+/.exec(tokens[i]);
    if (!meta) continue;
    const path = tokens[++i];
    if (meta[2] !== '160000') files.push({ blob: meta[3], path });
  }
  return files;
}

function scanVersions(files, label, names, hits, seen) {
  for (const { blob, path } of files) {
    const key = `${blob}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = label ? `${path} @ ${label}` : path;
    const inName = entriesInPath(path, names);
    if (inName.length > 0) hits.push({ where, line: 0, entries: inName });
    for (const h of scanBuffer(git(['cat-file', 'blob', blob], 'buffer'), names)) {
      hits.push({ where, ...h });
    }
  }
}

function scanStaged(names, hits) {
  const out = git(['diff', '--cached', '--raw', '-z', '--no-renames', '--diff-filter=ACMRT']);
  scanVersions(parseRaw(out), '', names, hits, new Set());
}

function scanRange(range, names, hits) {
  const seen = new Set();
  const shas = git(['rev-list', '--no-merges', range]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const raw = git([
      'diff-tree',
      '-r',
      '-z',
      '--root',
      '--no-commit-id',
      '--no-renames',
      '--diff-filter=ACMRT',
      sha,
    ]);
    scanVersions(parseRaw(raw), sha.slice(0, 8), names, hits, seen);
  }
  const log = git(['log', '--format=%x01%h%n%B', range]);
  for (const block of log.split('\u0001').filter(Boolean)) {
    const [sha, ...body] = block.split('\n');
    for (const h of scanText(body.join('\n'), names)) {
      hits.push({ where: `commit ${sha} message`, ...h });
    }
  }
}

function main(argv, out) {
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

  const hits = [];
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--git-staged') {
      scanStaged(names, hits);
      targets.push(arg);
    } else if (arg === '--git-range') {
      const range = argv[++i];
      if (!range) throw new Error('--git-range needs <a>..<b>');
      scanRange(range, names, hits);
      targets.push(`${arg} ${range}`);
    } else {
      scanDirectory(arg, names, hits);
      targets.push(arg);
    }
  }
  if (targets.length === 0) {
    console.error('check-private-names: give --git-staged, --git-range <a>..<b> or a directory.');
    return { code: 2, names };
  }
  for (const hit of hits) out(formatHit(hit, names));
  if (hits.length > 0) {
    out(
      `check-private-names: ${hits.length} hit(s) in ${targets.join(', ')}. The names are in ${source}; they are not printed.`,
    );
    return { code: 1, names };
  }
  out(`check-private-names: ${names.length} name(s) checked in ${targets.join(', ')}, no hit.`);
  return { code: 0, names };
}

let known = [];
try {
  // The targets echoed in a message are masked like everything else.
  const lines = [];
  const result = main(process.argv.slice(2), (line) => lines.push(line));
  known = result.names;
  for (const line of lines) console.log(mask(line, known));
  process.exit(result.code);
} catch (err) {
  try {
    known = resolveList().names ?? [];
  } catch {
    /* the list itself is unreadable: nothing to mask with */
  }
  console.error(
    `check-private-names: could not run the check: ${mask(String(err.message), known)}`,
  );
  process.exit(2);
}
