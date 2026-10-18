#!/usr/bin/env node
// check-private-names.mjs — fail when a private name reaches what is published.
//
// The names are read from a list kept OUTSIDE the repository (see
// lib/private-names.mjs): path from NODAL_PRIVATE_NAMES, default
// ~/.nodalai/private-names.txt, one name per line, `#` for comments. Each name is
// matched ignoring case and ignoring spaces, dashes and underscores, so every
// spelling of it is caught. A hit prints `file:line` and the line number of the
// entry in the list, never the name.
//
// Targets (any number):
//   --git-staged         the lines added to the index
//   --git-range <a>..<b> the lines added by those commits, and their messages;
//                        `<b>` alone scans the whole history of <b>
//   <directory>          every text file under it (the pack)
//
// No list configured: said on stdout, exit 0. Any hit: exit 1. Bad usage: exit 2.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatHit, listPath, loadList, scanDiff, scanText } from './lib/private-names.mjs';

const NUL = String.fromCharCode(0);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILE = 20_000_000;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

function scanDirectory(dir, names, hits) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(path, names, hits);
    } else if (entry.isFile() && statSync(path).size <= MAX_FILE) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(NUL)) continue; // binary
      for (const h of scanText(text, names)) hits.push({ where: path, ...h });
    }
  }
}

function scanRange(range, names, hits) {
  const [from, to] = range.includes('..') ? range.split('..') : [null, range];
  hits.push(...scanDiff(git(['diff', '-U0', '--no-color', from ?? EMPTY_TREE, to]), names));
  const log = git(['log', '--format=%x01%h%n%B', ...(from ? [`${from}..${to}`] : [to])]);
  for (const block of log.split('\u0001').filter(Boolean)) {
    const [sha, ...body] = block.split('\n');
    for (const h of scanText(body.join('\n'), names)) {
      hits.push({ where: `commit ${sha} message`, ...h });
    }
  }
}

function main(argv) {
  const path = listPath();
  const names = loadList(path);
  if (names === null) {
    console.log(
      `check-private-names: no private-names list configured (${path} is absent); nothing was checked.`,
    );
    return 0;
  }
  if (names.length === 0) {
    console.log(
      `check-private-names: the private-names list (${path}) has no entry; nothing was checked.`,
    );
    return 0;
  }

  const hits = [];
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--git-staged') {
      hits.push(...scanDiff(git(['diff', '--cached', '-U0', '--no-color']), names));
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
    return 2;
  }
  for (const hit of hits) console.log(formatHit(hit));
  if (hits.length > 0) {
    console.log(
      `check-private-names: ${hits.length} hit(s) in ${targets.join(', ')}. The names are in ${path}; they are not printed.`,
    );
    return 1;
  }
  console.log(
    `check-private-names: ${names.length} name(s) checked in ${targets.join(', ')}, no hit.`,
  );
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(`check-private-names: ${err.message}`);
  process.exit(2);
}
