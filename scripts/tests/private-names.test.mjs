// private-names.test.mjs — check-private-names.mjs, its pre-push hook and its CI
// step, against real temporary git repositories and directories.
//
// The list is built at run time from parts, so this file never holds a name.
//
// Mutations verified (each turns the named cases red):
//   - `isSeparator` keeps dashes, underscores and whitespace → the glued, spaced,
//     dashed, underscored and newline-cut cases;
//   - the path comparison (`entriesInPath`) made empty → the file, folder, gitlink,
//     rename and directory-name cases;
//   - the added-line scan dropped from `scanNetDiff` → the net-diff, merge-resolution
//     and size cases;
//   - the commit-message scan dropped from `scanRange` → the message cases;
//   - the binary listing dropped → the "not read" cases;
//   - `mask` made the identity → every "never printed" assertion;
//   - the CI step taking the script from the working tree instead of the base commit
//     → the "script from the base" case (the sentinel shows).

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mask, normalize, parseList, resolveList } from '../lib/private-names.mjs';

const SCRIPTS = resolve(import.meta.dirname, '..');
const CLI = join(SCRIPTS, 'check-private-names.mjs');
const FIRST = ['zorb', 'lux'].join('');
const SECOND = ['quin', 'tuple'].join('');
// Entry 1 is a comment, entries 2 and 3 are the names (a two-word one and a one-word one).
const LIST = `# private names\n${FIRST} link\n${SECOND}\n`;

let root;
let listFile;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const run = (args, { env = {}, cwd = root } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
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

function newRepo() {
  const dir = mkdtempSync(join(root, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, { 'README.md': 'base\n' }, 'base');
  return dir;
}

/** Writes `files` (path → string | Buffer | null to delete), commits, returns the sha. */
function commit(dir, files, message) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      git(dir, 'rm', '-q', '-f', path);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    git(dir, 'add', path);
  }
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();

describe('normalisation', () => {
  it('drops case, spaces, dashes and underscores on both sides', () => {
    expect(normalize('Zorb Lux_Link-X')).toBe('zorbluxlinkx');
    expect(parseList(LIST)).toEqual([
      { entry: 2, form: `${FIRST}link` },
      { entry: 3, form: SECOND },
    ]);
  });

  it('masks a name wherever it is spelled, leaving the rest', () => {
    const names = parseList(LIST);
    expect(mask(`x/${FIRST}_Link/y`, names)).toBe('x/[private #2]/y');
    expect(mask(`${SECOND}.md and ${FIRST}\nlink`, names)).toBe('[private #3].md and [private #2]');
  });

  it('reads the list from a path, or from NODAL_PRIVATE_NAMES_CONTENT which wins', () => {
    expect(resolveList({ NODAL_PRIVATE_NAMES: listFile }).names).toHaveLength(2);
    const inline = resolveList({
      NODAL_PRIVATE_NAMES_CONTENT: `${SECOND}\n`,
      NODAL_PRIVATE_NAMES: listFile,
    });
    expect(inline.names).toEqual([{ entry: 1, form: SECOND }]);
    expect(
      resolveList({ NODAL_PRIVATE_NAMES_CONTENT: '  ', NODAL_PRIVATE_NAMES: join(root, 'no') })
        .names,
    ).toBeNull();
  });
});

describe('--git-range: the net change', () => {
  it.each([
    ['the plain spelling', `see ${FIRST} link here`],
    ['glued', `see ${FIRST}link here`],
    ['spaced differently', `see ${FIRST}   link here`],
    ['dashed', `see ${FIRST}-link here`],
    ['underscored', `see ${FIRST}_link here`],
    ['another case', `see ${FIRST.toUpperCase()} Link here`],
  ])('an added line with the name %s is a hit at its line, never printed', (_l, text) => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': `one\ntwo\n${text}\n` }, 'add a');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a.txt:3  matches private-names entry 2');
    noName(r);
  });

  it('a name cut by a line break across two added lines is a hit at the first', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': `x\n${FIRST}\nlink\n` }, 'add a');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a.txt:2  matches private-names entry 2');
    noName(r);
  });

  it('reports the second entry by its own number', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': `${SECOND}\n` }, 'add a');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.stdout).toMatch(/a\.txt:1 {2}matches private-names entry 3/);
  });

  it('passes a clean change and says how many names it checked', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': 'nothing\n' }, 'add a');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 name(s) checked');
  });

  it.each([
    ['a file name', `notes-${FIRST}_link.md`],
    ['a folder name', `${SECOND}-dir/a.txt`],
    ['a glued file name', `sub/${FIRST}link.txt`],
  ])('%s is a hit on the path, printed masked', (_l, path) => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { [path]: 'clean\n' }, 'add');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[private #[23]\].*path matches private-names entry [23]/);
    noName(r);
  });

  it('a gitlink (submodule) path is a hit too', () => {
    const dir = newRepo();
    const base = head(dir);
    git(
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},vendor/${SECOND}-sub`,
    );
    git(dir, 'commit', '-q', '-m', 'link');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('vendor/[private #3]-sub');
    noName(r);
  });

  it('a rename to a path that holds the name is a hit', () => {
    const dir = newRepo();
    const base = head(dir);
    git(dir, 'mv', 'README.md', `${FIRST}_link.md`);
    git(dir, 'commit', '-q', '-m', 'rename');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('path matches private-names entry 2');
    noName(r);
  });

  it('a name only a MERGE RESOLUTION introduces is a hit', () => {
    const dir = newRepo();
    commit(dir, { 'f.txt': 'start\n' }, 'f');
    git(dir, 'checkout', '-q', '-b', 'side');
    commit(dir, { 'f.txt': 'side\n' }, 'side edit');
    git(dir, 'checkout', '-q', 'main');
    commit(dir, { 'f.txt': 'main\n' }, 'main edit');
    const base = head(dir);
    spawnSync('git', ['merge', '--no-commit', 'side'], { cwd: dir });
    writeFileSync(join(dir, 'f.txt'), `resolved with ${SECOND}\n`);
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', 'merge side');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('f.txt:1  matches private-names entry 3');
    noName(r);
  });

  it('a commit message is a hit, and so is the message of a merge commit', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': 'ok\n' }, `add a for ${FIRST}\nlink`);
    let r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/commit [0-9a-f]+ message:1 {2}matches private-names entry 2/);
    noName(r);

    const other = newRepo();
    commit(other, { 'a.txt': 'ok\n' }, 'a');
    git(other, 'checkout', '-q', '-b', 'side');
    commit(other, { 'b.txt': 'ok\n' }, 'b');
    git(other, 'checkout', '-q', 'main');
    commit(other, { 'c.txt': 'ok\n' }, 'c');
    const b = head(other);
    git(other, 'merge', '-q', '--no-ff', 'side', '-m', `merge ${SECOND}`);
    r = run(['--git-range', `${b}...HEAD`], { cwd: other });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/message:1 {2}matches private-names entry 3/);
    noName(r);
  });

  it('LIMIT, stated: a name added then removed inside the range is not seen', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': `${SECOND}\n` }, 'add');
    commit(dir, { 'a.txt': null }, 'drop');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(0);
  });

  it('a binary file is listed as not read, with a count, and does not fail the check', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'blob.bin': Buffer.concat([Buffer.alloc(16), Buffer.from(SECOND)]) }, 'bin');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not read: blob.bin (binary)');
    expect(r.stdout).toContain('1 file(s) not read');
    noName(r);
  });

  it('a text file above the size limit is listed as not read (size)', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'big.txt': `${'a'.repeat(99)}\n`.repeat(90_000) + `${SECOND}\n` }, 'big');
    const r = run(['--git-range', `${base}...HEAD`], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not read: big.txt (size)');
  }, 60000);

  it('an unknown revision is a failed check (exit 2), never a hit (exit 1)', () => {
    const dir = newRepo();
    const r = run(['--git-range', `${'0'.repeat(39)}1...HEAD`], { cwd: dir });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not run the check');
  });
});

describe('--git-staged', () => {
  it('an added line is a hit; a staged path too; a clean index passes', () => {
    const dir = newRepo();
    expect(run(['--git-staged'], { cwd: dir }).status).toBe(0);
    writeFileSync(join(dir, 'a.txt'), `x\n${FIRST}_link\n`);
    writeFileSync(join(dir, `${SECOND}-notes.txt`), 'clean\n');
    git(dir, 'add', '.');
    const r = run(['--git-staged'], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a.txt:2  matches private-names entry 2');
    expect(r.stdout).toContain('[private #3]-notes.txt');
    noName(r);
  });
});

describe('a directory (the pack)', () => {
  function pack(files) {
    const dir = mkdtempSync(join(root, 'pack-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  }

  it('hits a name in a file, in a file name and in a node_modules folder name', () => {
    const dir = pack({
      'a/b.txt': `x\n${FIRST} link\n`,
      [`node_modules/${SECOND}-dep/index.js`]: 'clean\n',
      [`${FIRST}_link.json`]: '{}\n',
    });
    const r = run([dir]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/b\.txt:2 {2}matches private-names entry 2/);
    expect(r.stdout).toContain('node_modules');
    expect(r.stdout).toContain('[private #3]-dep');
    noName(r);
  });

  it('lists a binary as not read instead of skipping it, and passes a clean pack', () => {
    const dir = pack({
      'a.txt': 'clean\n',
      'logo.png': Buffer.concat([Buffer.alloc(9), Buffer.from(SECOND)]),
    });
    const r = run([dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('logo.png (binary)');
    expect(r.stdout).toContain('1 file(s) not read');
    noName(r);
  });

  it('a missing directory is reported as missing (exit 2), not as a hit', () => {
    const r = run([join(root, 'no-such-pack')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('directory not found');
  });
});

describe('the list and the exit codes', () => {
  it('absent: said clearly, exit 0', () => {
    const r = run([root], { env: { NODAL_PRIVATE_NAMES: join(root, 'nope.txt') } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no private-names list configured');
  });

  it('with no entry: said, exit 0', () => {
    const empty = join(root, 'empty.txt');
    writeFileSync(empty, '# nothing yet\n\n');
    const r = run([root], { env: { NODAL_PRIVATE_NAMES: empty } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('has no entry');
  });

  it('a list given as content works with no file at all', () => {
    const dir = newRepo();
    const base = head(dir);
    commit(dir, { 'a.txt': `${SECOND}\n` }, 'a');
    const r = run(['--git-range', `${base}...HEAD`], {
      cwd: dir,
      env: {
        NODAL_PRIVATE_NAMES_CONTENT: `# s\n${SECOND}\n`,
        NODAL_PRIVATE_NAMES: join(root, 'no'),
      },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a.txt:1  matches private-names entry 2');
  });

  it('asked for no target: usage error, exit 2', () => {
    expect(run([]).status).toBe(2);
  });
});

// ─── The hook and the CI step run through `sh`; skipped where there is none ──

const hasSh = spawnSync('sh', ['-c', 'true']).status === 0;

/** A repository carrying copies of the scripts, an `origin` and a base commit. */
function repoWithScripts() {
  const dir = newRepo();
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(CLI, join(dir, 'scripts', 'check-private-names.mjs'));
  copyFileSync(
    join(SCRIPTS, 'lib', 'private-names.mjs'),
    join(dir, 'scripts', 'lib', 'private-names.mjs'),
  );
  git(dir, 'add', 'scripts');
  git(dir, 'commit', '-q', '-m', 'scripts');
  return dir;
}

describe.skipIf(!hasSh)('.githooks/pre-push', () => {
  const HOOK = resolve(SCRIPTS, '..', '.githooks', 'pre-push');
  const ZERO = '0'.repeat(40);

  const push = (dir, localSha, remoteSha, env = {}) =>
    spawnSync('sh', [HOOK], {
      cwd: dir,
      encoding: 'utf8',
      input: `refs/heads/feat ${localSha} refs/heads/feat ${remoteSha}\n`,
      env: { ...process.env, NODAL_PRIVATE_NAMES: listFile, ...env },
    });

  it('a hit refuses the push with the hit message; a clean branch passes', () => {
    const dir = repoWithScripts();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, { 'ok.txt': 'fine\n' }, 'ok');
    expect(push(dir, head(dir), ZERO).status).toBe(0);
    commit(dir, { 'bad.txt': `${SECOND}\n` }, 'bad');
    const r = push(dir, head(dir), ZERO);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a private name is in what you are pushing');
    expect(r.stdout).not.toContain('could NOT run');
    noName(r);
  });

  it('an unknown remote sha falls back to the merge-base with the default branch', () => {
    const dir = repoWithScripts();
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, { 'bad.txt': `${SECOND}\n` }, 'bad');
    const r = push(dir, head(dir), 'f'.repeat(40));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('a private name is in what you are pushing');
  });

  it('a check that cannot run says so, apart from a hit, and names the way to skip', () => {
    const dir = repoWithScripts();
    git(dir, 'branch', '-m', 'trunk'); // no main/master/origin: no base to compare with
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, { 'ok.txt': 'fine\n' }, 'ok');
    const r = push(dir, head(dir), ZERO);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('could NOT run');
    expect(r.stdout).toContain('NODAL_SKIP_HYGIENE=1');
    expect(r.stdout).not.toContain('a private name is in what you are pushing');
  });

  it('NODAL_SKIP_HYGIENE=1 skips, and says so', () => {
    const dir = repoWithScripts();
    const r = push(dir, head(dir), ZERO, { NODAL_SKIP_HYGIENE: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipped');
  });
});

describe.skipIf(!hasSh)('the CI step takes the script from the BASE commit', () => {
  const ci = readFileSync(resolve(SCRIPTS, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const block = ci.slice(ci.indexOf('- name: Private names'));
  const after = block.slice(block.indexOf('run: |\n') + 'run: |\n'.length);
  const stepScript = after
    .split('\n')
    .reduce(
      (acc, line) =>
        acc.done || (line.trim() && !line.startsWith('          '))
          ? { ...acc, done: true }
          : { ...acc, lines: [...acc.lines, line.slice(10)] },
      { lines: [], done: false },
    )
    .lines.join('\n');

  /** An `origin` (a plain repo reached by file URL) with a base on main and a PR on `pr`. */
  function setup({ baseHasScripts, prEditsScript }) {
    const origin = baseHasScripts ? repoWithScripts() : newRepo();
    const base = head(origin);
    git(origin, 'checkout', '-q', '-b', 'pr');
    if (prEditsScript) {
      // A PR that tries to read the secret: it prints the environment's list.
      commit(
        origin,
        {
          'scripts/check-private-names.mjs':
            "console.log('SENTINEL', process.env.NODAL_PRIVATE_NAMES_CONTENT); process.exit(0);\n",
        },
        'tamper',
      );
    }
    commit(origin, { 'added.txt': `${SECOND}\n` }, 'adds a name');
    const prHead = head(origin);
    const clone = mkdtempSync(join(root, 'clone-'));
    git(clone, 'init', '-q', '-b', 'pr');
    git(clone, 'remote', 'add', 'origin', pathToFileURL(origin).href);
    git(clone, 'fetch', '-q', 'origin', 'pr');
    git(clone, 'checkout', '-q', '-f', prHead);
    return { clone, base, prHead };
  }

  const runStep = ({ clone, base, prHead }, secret = LIST) =>
    spawnSync('sh', ['-c', stepScript], {
      cwd: clone,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODAL_PRIVATE_NAMES_CONTENT: secret,
        BASE_SHA: base,
        HEAD_SHA: prHead,
        RUNNER_TEMP: mkdtempSync(join(root, 'runner-')),
      },
    });

  it('finds the step', () => {
    expect(stepScript).toContain('git show "$BASE_SHA:scripts/check-private-names.mjs"');
  });

  it('runs the base script on the PR range and finds the name', () => {
    const r = runStep(setup({ baseHasScripts: true, prEditsScript: false }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('added.txt:1  matches private-names entry 3');
    noName(r);
  }, 60000);

  it('a PR that rewrites the script cannot make it print the secret', () => {
    const r = runStep(setup({ baseHasScripts: true, prEditsScript: true }));
    expect(`${r.stdout}${r.stderr}`).not.toContain('SENTINEL');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('added.txt:1  matches private-names entry 3');
    noName(r);
  }, 60000);

  it('says so and passes when the base has no script yet, or when there is no secret', () => {
    let r = runStep(setup({ baseHasScripts: false, prEditsScript: false }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('base commit has no check-private-names script yet');
    r = runStep(setup({ baseHasScripts: true, prEditsScript: false }), '');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no NODAL_PRIVATE_NAMES secret');
  }, 60000);
});
