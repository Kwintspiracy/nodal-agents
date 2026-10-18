// private-names.test.mjs — check-private-names.mjs, against a real directory and
// a real throwaway git repository.
//
// The list is built at run time from parts, so this file never holds a name.
//
// Mutation verified: making `normalize` keep spaces, dashes and underscores turns
// the glued, spaced and underscored cases red (the dashed one too, from the
// spaced entry).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalize, parseList } from '../lib/private-names.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', 'check-private-names.mjs');
const FIRST = ['zorb', 'lux'].join('');
const SECOND = ['quin', 'tuple'].join('');
// Entry 1 is a comment, entry 2 and 3 are the names (a two-word one and a one-word one).
const LIST = `# private names\n${FIRST} link\n${SECOND}\n`;

let root;
let listFile;
const run = (args, env = {}, cwd = root) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODAL_PRIVATE_NAMES: listFile, ...env },
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'private-names-'));
  listFile = join(root, 'list.txt');
  writeFileSync(listFile, LIST);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dirWith(content) {
  const dir = mkdtempSync(join(root, 'pack-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'a.txt'), content);
  return dir;
}

describe('normalisation', () => {
  it('drops case, spaces, dashes and underscores on both sides', () => {
    expect(normalize('Zorb Lux_Link-X')).toBe('zorbluxlinkx');
    expect(parseList(LIST)).toEqual([
      { entry: 2, form: `${FIRST}link` },
      { entry: 3, form: SECOND },
    ]);
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
  ])('hits %s, with file:line and the entry number, never the name', (_label, text) => {
    const dir = dirWith(`first\nsecond\n${text}\n`);
    const r = run([dir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${join(dir, 'sub', 'a.txt')}:3  matches private-names entry 2`);
    expect(r.stdout.toLowerCase()).not.toContain(FIRST);
    expect(r.stdout.toLowerCase()).not.toContain(SECOND);
    expect(r.stderr.toLowerCase()).not.toContain(FIRST);
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
    expect(r.stdout.toLowerCase()).not.toContain(FIRST);
    git('reset', '-q');
    git('checkout', '--', 'a.txt');
  });

  it('--git-staged: a clean index passes', () => {
    expect(run(['--git-staged'], {}, repo).status).toBe(0);
  });

  it('--git-range: a hit in a commit message and one in an added line', () => {
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'b.txt'), `x\n${SECOND}\n`);
    git('add', 'b.txt');
    git('commit', '-q', '-m', `add b about ${FIRST}link`);
    const r = run(['--git-range', `${base}..HEAD`], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('b.txt:2  matches private-names entry 3');
    expect(r.stdout).toMatch(/commit [0-9a-f]+ message:1 {2}matches private-names entry 2/);
    expect(r.stdout.toLowerCase()).not.toContain(FIRST);
  });

  it('--git-range: a range that adds nothing private passes', () => {
    const head = git('rev-parse', 'HEAD').trim();
    expect(run(['--git-range', `${head}..${head}`], {}, repo).status).toBe(0);
  });
});
