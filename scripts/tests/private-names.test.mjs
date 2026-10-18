// private-names.test.mjs — check-private-names.mjs, against a real directory and
// a real throwaway git repository.
//
// The list is built at run time from parts, so this file never holds a name.
//
// Mutations verified (each turns the named cases red):
//   - `isSeparator` keeps dashes, underscores and whitespace → the glued, spaced,
//     dashed, underscored, newline-cut and path cases;
//   - the path comparison (`entriesInPath`) removed → the file-name, folder-name
//     and rename cases;
//   - the UTF-16 views removed from `scanStream` → the UTF-16 cases;
//   - `base64Needles` returning nothing → the three base64 offsets;
//   - `mask` returning its input → the path-leak cases.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mask, normalize, parseList, resolveList } from '../lib/private-names.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', 'check-private-names.mjs');
const FIRST = ['zorb', 'lux'].join('');
const SECOND = ['quin', 'tuple'].join('');
// Entry 1 is a comment, entries 2 and 3 are the names (a two-word one and a one-word one).
const LIST = `# private names\n${FIRST} link\n${SECOND}\n`;

let root;
let listFile;
const run = (args, env = {}, cwd = root) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODAL_PRIVATE_NAMES: listFile, ...env },
  });
const noName = (r) => {
  const all = `${r.stdout}${r.stderr}`.toLowerCase();
  expect(all).not.toContain(FIRST);
  expect(all).not.toContain(SECOND);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'private-names-'));
  listFile = join(root, 'list.txt');
  writeFileSync(listFile, LIST);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dirWith(content, name = 'a.txt', sub = 'sub') {
  const dir = mkdtempSync(join(root, 'pack-'));
  mkdirSync(join(dir, sub));
  writeFileSync(join(dir, sub, name), content);
  return dir;
}

const utf16le = (s) => Buffer.from(s, 'utf16le');
const utf16be = (s) => Buffer.from(s, 'utf16le').swap16();

describe('normalisation', () => {
  it('drops case, spaces, dashes and underscores on both sides', () => {
    expect(normalize('Zorb Lux_Link-X')).toBe('zorbluxlinkx');
    expect(parseList(LIST).map(({ entry, form }) => ({ entry, form }))).toEqual([
      { entry: 2, form: `${FIRST}link` },
      { entry: 3, form: SECOND },
    ]);
  });

  it('masks a name wherever it is spelled, leaving the rest', () => {
    const names = parseList(LIST);
    expect(mask(`x/${FIRST}_Link/y`, names)).toBe('x/[private #2]/y');
    expect(mask(`${SECOND}.md and ${FIRST}\nlink`, names)).toBe('[private #3].md and [private #2]');
  });
});

describe('scanning a directory', () => {
  it.each([
    ['the plain spelling', `see ${FIRST} link here`],
    ['glued', `see ${FIRST}link here`],
    ['spaced differently', `see ${FIRST}   link here`],
    ['dashed', `see ${FIRST}-link here`],
    ['underscored', `see ${FIRST}_link here`],
    ['another case', `see ${FIRST.toUpperCase()} Link here`],
    ['cut by a newline', `see ${FIRST}\nlink here`],
    ['cut by a blank line and indentation', `see ${FIRST}\r\n\r\n    link here`],
  ])('hits %s, with file:line and the entry number, never the name', (_label, text) => {
    const dir = dirWith(`first\nsecond\n${text}\n`);
    const r = run([dir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'sub', 'a.txt')}:3  matches private-names entry 2`);
    noName(r);
  });

  it('reports the second entry by its own number', () => {
    const r = run([dirWith(`${SECOND}\n`)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/:1 {2}matches private-names entry 3/);
  });

  it('passes a clean directory and says how many names it checked', () => {
    const r = run([dirWith('nothing to see\n')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 name(s) checked');
  });

  it.each([
    ['a file name', 'sub', `notes-${FIRST}_link.md`],
    ['a folder name', `${SECOND}-dir`, 'a.txt'],
    ['a glued file name', 'sub', `${FIRST}link.txt`],
  ])('hits %s, and the path printed hides the name', (_label, sub, name) => {
    const dir = dirWith('nothing inside\n', name, sub);
    const r = run([dir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/path matches private-names entry [23]/);
    expect(r.stdout).toContain('[private #');
    noName(r);
  });

  it('does not leak the name through a content hit in a named file either', () => {
    const dir = dirWith(`${FIRST} link\n`, `${SECOND}.txt`);
    const r = run([dir]);
    expect(r.status).toBe(1);
    noName(r);
  });
});

describe('scanning bytes', () => {
  const text = `${FIRST} link`;

  it.each([
    ['UTF-16 little endian', () => Buffer.concat([Buffer.from('pre\n'), utf16le(text)])],
    ['UTF-16 big endian', () => Buffer.concat([Buffer.from('pre\n'), utf16be(text)])],
    ['UTF-16 at an odd offset', () => Buffer.concat([Buffer.from('x'), utf16le(text)])],
    [
      'a binary with NUL bytes around',
      () => Buffer.concat([Buffer.alloc(40), Buffer.from(text), Buffer.alloc(9)]),
    ],
  ])('hits %s', (_label, make) => {
    const r = run([dirWith(make(), 'blob.bin')]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/blob\.bin:\d+ {2}matches private-names entry 2/);
    noName(r);
  });

  it.each([
    ['offset 0', 0],
    ['offset 1', 1],
    ['offset 2', 2],
  ])('hits the base64 of the name at byte %s', (_label, k) => {
    const wrapped = Buffer.concat([
      Buffer.alloc(k, 'q'),
      Buffer.from(`${FIRST}link`),
      Buffer.from('zz'),
    ])
      .toString('base64')
      .replace(/(.{20})/g, '$1\n');
    const r = run([dirWith(`data:\n${wrapped}\n`)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/matches private-names entry 2/);
    noName(r);
  });

  it('reads a file larger than the scan chunk, name at the very end', () => {
    const dir = mkdtempSync(join(root, 'big-'));
    const fd = openSync(join(dir, 'big.bin'), 'w');
    const block = Buffer.alloc(1024 * 1024, 'a');
    for (let i = 0; i < 21; i++) writeSync(fd, block);
    writeSync(fd, `\n${SECOND}\n`);
    closeSync(fd);
    const r = run([dir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('big.bin:2  matches private-names entry 3');
    noName(r);
  }, 60000);
});

describe('the list', () => {
  it('absent: said clearly, exit 0', () => {
    const r = run([dirWith(`${FIRST} link\n`)], { NODAL_PRIVATE_NAMES: join(root, 'nope.txt') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no private-names list configured');
  });

  it('with no entry: said, exit 0', () => {
    const empty = join(root, 'empty.txt');
    writeFileSync(empty, '# nothing yet\n\n');
    const r = run([dirWith(`${FIRST} link\n`)], { NODAL_PRIVATE_NAMES: empty });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('has no entry');
  });

  it('content in NODAL_PRIVATE_NAMES_CONTENT is the list, and wins over a path', () => {
    const r = run([dirWith(`${SECOND}\n`)], {
      NODAL_PRIVATE_NAMES_CONTENT: `# secret\n${SECOND}\n`,
      NODAL_PRIVATE_NAMES: join(root, 'nope.txt'),
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/matches private-names entry 2/);
    expect(
      resolveList({ NODAL_PRIVATE_NAMES_CONTENT: '   ', NODAL_PRIVATE_NAMES: join(root, 'x') })
        .names,
    ).toBeNull();
    noName(r);
  });

  it('asked for no target: usage error, exit 2', () => {
    expect(run([]).status).toBe(2);
  });
});

describe('scanning git', () => {
  let repo;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  beforeAll(() => {
    repo = mkdtempSync(join(root, 'repo-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'base');
  });

  it('--git-staged: an added line is a hit, at its line in the new file', () => {
    writeFileSync(join(repo, 'a.txt'), `one\ntwo ${FIRST}_link\n`);
    git('add', 'a.txt');
    const r = run(['--git-staged'], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a.txt:2  matches private-names entry 2');
    noName(r);
    git('reset', '-q');
    git('checkout', '--', 'a.txt');
  });

  it('--git-staged: a clean index passes', () => {
    expect(run(['--git-staged'], {}, repo).status).toBe(0);
  });

  it('--git-staged: a staged file whose NAME holds the name is a hit, printed masked', () => {
    writeFileSync(join(repo, `${SECOND}-notes.txt`), 'clean\n');
    git('add', '.');
    const r = run(['--git-staged'], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[private #3]');
    noName(r);
    git('reset', '-q');
    rmSync(join(repo, `${SECOND}-notes.txt`));
  });

  it('--git-range: a hit in a commit message and one in an added line', () => {
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'b.txt'), `x\n${SECOND}\n`);
    git('add', 'b.txt');
    git('commit', '-q', '-m', `add b about ${FIRST}link`);
    const r = run(['--git-range', `${base}..HEAD`], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('b.txt @ ');
    expect(r.stdout).toMatch(/b\.txt @ [0-9a-f]+:2 {2}matches private-names entry 3/);
    expect(r.stdout).toMatch(/commit [0-9a-f]+ message:1 {2}matches private-names entry 2/);
    noName(r);
  });

  it('--git-range: a binary file added then removed is still found (blob content)', () => {
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(
      join(repo, 'c.bin'),
      Buffer.concat([Buffer.alloc(8), utf16le(`${SECOND}`), Buffer.alloc(8)]),
    );
    git('add', 'c.bin');
    git('commit', '-q', '-m', 'add c');
    git('rm', '-q', 'c.bin');
    git('commit', '-q', '-m', 'drop c');
    const r = run(['--git-range', `${base}..HEAD`], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/c\.bin @ [0-9a-f]+:\d+ {2}matches private-names entry 3/);
    noName(r);
  });

  it('--git-range: a rename to a name that holds the name is a hit on the path', () => {
    const base = git('rev-parse', 'HEAD').trim();
    git('mv', 'a.txt', `${FIRST}_link.txt`);
    git('commit', '-q', '-m', 'rename a');
    const r = run(['--git-range', `${base}..HEAD`], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /\[private #2\]\.txt @ [0-9a-f]+ {2}path matches private-names entry 2/,
    );
    noName(r);
  });

  it('--git-range: a range that adds nothing private passes', () => {
    const head = git('rev-parse', 'HEAD').trim();
    expect(run(['--git-range', `${head}..${head}`], {}, repo).status).toBe(0);
  });

  it('--git-range: an unknown commit is a failed check (exit 2), never a hit (exit 1)', () => {
    const r = run(['--git-range', `${'0'.repeat(39)}1..HEAD`], {}, repo);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not run the check');
  });
});
