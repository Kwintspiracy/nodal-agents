// internal-git.test.ts — a git that Nodal starts for itself never executes what
// a repository names, never reads the user's or the system's configuration,
// and never receives Nodal's secrets.
//
// With the REAL git of the machine (present on every CI image: a missing git
// is red, never a skip), in a temporary folder whose name carries spaces and
// non-ASCII characters. Every program-starting key is planted twice: once
// under a git launched DIRECTLY (the witness: the trap is armed, the marker
// file appears), once through the launcher (no marker, and the operation still
// gives its real answer).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

/** What the resolution of git's binary answers; `undefined` = the real answer. */
const forcedResolution = vi.hoisted(() => ({ value: undefined as string | null | undefined }));

vi.mock('../git-binary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../git-binary')>();
  return {
    ...real,
    resolveGitBinary: async (): Promise<string | null> =>
      forcedResolution.value === undefined ? real.resolveGitBinary() : forcedResolution.value,
  };
});
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitBinaryMissingError,
  GitConfigUnreadableError,
  InternalGitRefusedError,
  hostProgramRunner,
  internalGitEnvironment,
  overridesForDeclaredKeys,
  runInternalGit,
  spawnInternalGit,
  type ProgramRunner,
} from '../internal-git';

const isWindows = process.platform === 'win32';
const fwd = (p: string): string => p.split('\\').join('/');

let root = '';
let repo = '';
let witnessDir = '';
let marker = '';
let witness = '';

/** The planted program: `node <witness> <label>` appends its label to the marker. */
const planted = (label: string): string => `node "${fwd(witness)}" ${label}`;

/** A git launched DIRECTLY, as Nodal did before the launcher (fixtures and witnesses). */
function rawGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      // The witness must not depend on this machine's own git configuration.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig'),
      ...env,
    },
  });
}

/** Like `rawGit`, but a failing git is part of the witness (it ran the trap first). */
function rawGitTolerant(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  try {
    rawGit(cwd, args, env);
  } catch {
    /* the planted program ran (or not): the marker says */
  }
}

const fired = (): string => (existsSync(marker) ? readFileSync(marker, 'utf8') : '');

function newRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  rawGit(dir, ['init', '-q']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'same\n');
  rawGit(dir, ['add', 'a.txt', 'b.txt']);
  rawGit(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
}

/**
 * Changes `a.txt` (same size: git must read it) and only the date of
 * `b.txt`: the git that checks this repository refreshes its index entry, and
 * a git allowed to write that index then does (and fires its index hook).
 */
function touchRepo(dir: string): void {
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  utimesSync(join(dir, 'b.txt'), 1_000_000_000, 1_000_000_000);
}

const git = (args: string[], opts: { cwd?: string; gitEnv?: Record<string, string> } = {}) =>
  runInternalGit(hostProgramRunner, args, {
    cwd: opts.cwd ?? repo,
    ...(opts.gitEnv ? { gitEnv: opts.gitEnv } : {}),
    timeout: 30_000,
    writableRoots: [],
    readableRoots: [],
  });

beforeEach(() => {
  // Spaces and non-ASCII characters in the repository's own path.
  root = mkdtempSync(join(tmpdir(), 'nodal internal-git dépôt é '));
  writeFileSync(join(root, 'empty-gitconfig'), '');
  // The witness lives where its path needs no quoting in an `ext::` URL.
  witnessDir = mkdtempSync(join(tmpdir(), 'nodal-witness-'));
  marker = join(witnessDir, 'MARKER');
  witness = join(witnessDir, 'witness.cjs');
  writeFileSync(
    witness,
    `require('fs').appendFileSync(${JSON.stringify(marker)}, (process.argv[2] || '?') + '\\n');\n`,
  );
  repo = join(root, 'repo');
  newRepo(repo);
});

afterEach(() => {
  for (const d of [root, witnessDir]) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

interface Trap {
  readonly name: string;
  /** Plants the trap in `repo`. */
  plant(): void;
  /** What Nodal's git runs on it. */
  readonly args: () => string[];
  readonly gitEnv?: Record<string, string>;
  /** The real answer the operation must still give (or the loud refusal it must give). */
  check(result: { stdout: string } | Error): void;
}

const okStdout = (r: { stdout: string } | Error): string => {
  if (r instanceof Error) throw r;
  return r.stdout;
};

const TRAPS: readonly Trap[] = [
  {
    name: 'core.fsmonitor (status)',
    plant: () => {
      rawGit(repo, ['config', 'core.fsmonitor', planted('fsmonitor')]);
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['status', '--porcelain'],
    check: (r) => expect(okStdout(r)).toMatch(/^ M a\.txt$/m),
  },
  {
    name: 'a hook in the hooks directory (add)',
    plant: () => {
      const hook = join(repo, '.git', 'hooks', 'post-index-change');
      writeFileSync(hook, `#!/bin/sh\n${planted('hook')}\n`);
      chmodSync(hook, 0o755);
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['add', 'a.txt'],
    check: (r) => {
      okStdout(r);
      expect(rawGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
    },
  },
  {
    name: 'a clean filter the repository names (add)',
    plant: () => {
      rawGit(repo, ['config', 'filter.nodaltemoin.clean', planted('clean')]);
      rawGit(repo, ['config', 'filter.nodaltemoin.required', 'true']);
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt filter=nodaltemoin\n');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['add', 'a.txt'],
    // The bytes are stored as they are on disk: no filter ran.
    check: (r) => {
      okStdout(r);
      expect(rawGit(repo, ['cat-file', '-p', ':a.txt'], { GIT_ATTR_NOSYSTEM: '1' })).toBe('two\n');
    },
  },
  {
    name: 'a process filter the repository names (add)',
    plant: () => {
      rawGit(repo, ['config', 'filter.nodaltemoin.process', planted('process')]);
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt filter=nodaltemoin\n');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['add', 'a.txt'],
    check: (r) => {
      okStdout(r);
      expect(rawGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
    },
  },
  {
    name: 'a smudge filter the repository names (checkout)',
    plant: () => {
      rawGit(repo, ['config', 'filter.nodaltemoin.smudge', planted('smudge')]);
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt filter=nodaltemoin\n');
      rmSync(join(repo, 'a.txt'));
    },
    args: () => ['checkout', '--', 'a.txt'],
    check: (r) => {
      okStdout(r);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    },
  },
  {
    name: 'diff.external (diff)',
    plant: () => {
      rawGit(repo, ['config', 'diff.external', planted('external')]);
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['diff'],
    check: (r) => expect(okStdout(r)).toMatch(/^\+two$/m),
  },
  {
    name: 'a diff driver command the repository names (diff)',
    plant: () => {
      rawGit(repo, ['config', 'diff.nodaltemoin.command', planted('driver')]);
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt diff=nodaltemoin\n');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['diff'],
    check: (r) => expect(okStdout(r)).toMatch(/^\+two$/m),
  },
  {
    name: 'a textconv the repository names (diff)',
    plant: () => {
      rawGit(repo, ['config', 'diff.nodaltemoin.textconv', planted('textconv')]);
      writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt diff=nodaltemoin\n');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
    },
    args: () => ['diff'],
    check: (r) => expect(okStdout(r)).toMatch(/^\+two$/m),
  },
  {
    name: 'a signature-checking program (log of a signed commit)',
    plant: () => {
      const tree = rawGit(repo, ['write-tree']).trim();
      const head = rawGit(repo, ['rev-parse', 'HEAD']).trim();
      const commit =
        `tree ${tree}\nparent ${head}\n` +
        'author t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n' +
        'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n' +
        '\nsigned\n';
      const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
        cwd: repo,
        input: commit,
        encoding: 'utf8',
      }).trim();
      rawGit(repo, ['update-ref', 'HEAD', sha]);
      rawGit(repo, ['config', 'log.showSignature', 'true']);
      // `gpg.program` is a program, not a shell line: a script of its own.
      const gpg = join(witnessDir, 'gpg-witness.sh');
      writeFileSync(gpg, `#!/bin/sh\n${planted('gpg')}\n`);
      chmodSync(gpg, 0o755);
      rawGit(repo, ['config', 'gpg.program', fwd(gpg)]);
    },
    args: () => ['log', '-1', '--format=%s'],
    check: (r) => expect(okStdout(r).trim()).toBe('signed'),
  },
  {
    name: 'a transport a partial clone would start (cat-file of a missing object)',
    plant: () => {
      rawGit(repo, ['config', 'core.repositoryformatversion', '1']);
      rawGit(repo, ['config', 'extensions.partialClone', 'origin']);
      rawGit(repo, ['config', 'remote.origin.url', `ext::node ${fwd(witness)} transport`]);
      rawGit(repo, ['config', 'remote.origin.promisor', 'true']);
      rawGit(repo, ['config', 'protocol.ext.allow', 'always']);
    },
    args: () => ['cat-file', '-p', '0123456789abcdef0123456789abcdef01234567'],
    // The object is missing and stays missing: refused, loudly.
    check: (r) => expect(r).toBeInstanceOf(Error),
  },
];

describe('runInternalGit — what a repository names is never executed @cap:executer-une-commande/moteur', () => {
  for (const trap of TRAPS) {
    it(`witness: a git launched directly runs the planted program — ${trap.name}`, () => {
      trap.plant();
      rawGitTolerant(repo, trap.args(), trap.gitEnv);
      expect(fired(), 'the trap is not armed: this case would prove nothing').not.toBe('');
    });

    it(`through the launcher: nothing runs, and the answer is real — ${trap.name}`, async () => {
      trap.plant();
      const r = await git(trap.args(), trap.gitEnv ? { gitEnv: trap.gitEnv } : {}).catch(
        (e: unknown) => e as Error,
      );
      expect(fired(), 'a planted program ran').toBe('');
      trap.check(r);
    });
  }

  it('a hook the configuration declares by name never runs (git with configured hooks)', async () => {
    rawGit(repo, ['config', 'hook.nodaltemoin.command', planted('cfghook')]);
    rawGit(repo, ['config', 'hook.nodaltemoin.event', 'post-index-change']);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    rawGit(repo, ['add', 'a.txt']);
    const supported = fired() !== '';
    rawGit(repo, ['reset', '-q']);
    rmSync(marker, { force: true });
    // A git without configured hooks has nothing to switch off: the launcher
    // still adds, and nothing runs.
    await git(['add', 'a.txt']);
    expect(fired(), `a configured hook ran (this git supports them: ${supported})`).toBe('');
    expect(rawGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt');
  });

  it('a status reads the repository and never rewrites its index', async () => {
    // Only the date changes: a git allowed to would refresh and rewrite it.
    utimesSync(join(repo, 'b.txt'), 1_000_000_000, 1_000_000_000);
    const before = readFileSync(join(repo, '.git', 'index'));
    const { stdout } = await git(['status', '--porcelain']);
    expect(stdout).toBe('');
    expect(readFileSync(join(repo, '.git', 'index')).equals(before)).toBe(true);
  });

  it('a streamed git (spawn) gets the same configuration', async () => {
    rawGit(repo, ['config', 'core.fsmonitor', planted('fsmonitor')]);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const child = await spawnInternalGit(hostProgramRunner, ['status', '--porcelain'], {
      cwd: repo,
      writableRoots: [],
      readableRoots: [],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += String(c)));
    child.stderr.resume();
    expect((await child.closed).code).toBe(0);
    expect(out).toMatch(/^ M a\.txt$/m);
    expect(fired()).toBe('');
  });

  it.runIf(isWindows)(
    'the same on a Windows path written with backslashes and with forward slashes',
    async () => {
      rawGit(repo, ['config', 'core.fsmonitor', planted('fsmonitor')]);
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      for (const cwd of [repo.split('/').join('\\'), fwd(repo)]) {
        const { stdout } = await git(['status', '--porcelain'], { cwd });
        expect(stdout).toMatch(/^ M a\.txt$/m);
      }
      expect(fired()).toBe('');
    },
  );
});

describe('runInternalGit — nested repositories @cap:executer-une-commande/moteur', () => {
  /**
   * A repository nested in `repo` (and one nested in it), recorded in the
   * parent's index: the parent's git checks each with a child git. The trap is
   * planted AFTER the fixture's own git ran, and the file changes keep their
   * size, so the child must read the content (and so run a filter).
   */
  function nestedRepos(): { nested: string; deeper: string } {
    const nested = join(repo, 'nested');
    newRepo(nested);
    const deeper = join(nested, 'deeper');
    newRepo(deeper);
    rawGit(nested, ['add', 'deeper']);
    rawGit(nested, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'deeper']);
    rawGit(repo, ['add', 'nested']);
    rawGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'nested']);
    return { nested, deeper };
  }

  const NESTED_TRAPS: ReadonlyArray<{ name: string; plant: (dir: string) => void }> = [
    {
      name: 'core.fsmonitor',
      plant: (dir) => rawGit(dir, ['config', 'core.fsmonitor', planted('nested-fsmonitor')]),
    },
    {
      name: 'a hook in the hooks directory',
      plant: (dir) => {
        const hook = join(dir, '.git', 'hooks', 'post-index-change');
        writeFileSync(hook, `#!/bin/sh\n${planted('nested-hook')}\n`);
        chmodSync(hook, 0o755);
      },
    },
    {
      name: 'a clean filter it names itself',
      plant: (dir) => {
        rawGit(dir, ['config', 'filter.nodalnested.clean', planted('nested-clean')]);
        writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.txt filter=nodalnested\n');
      },
    },
  ];

  for (const trap of NESTED_TRAPS) {
    for (const level of ['nested', 'deeper'] as const) {
      it(`witness: the parent git launched directly runs it — ${trap.name}, ${level}`, () => {
        const dirs = nestedRepos();
        trap.plant(dirs[level]);
        touchRepo(dirs[level]);
        rawGitTolerant(repo, ['add', '-A']);
        rawGitTolerant(repo, ['status', '--porcelain']);
        expect(fired(), 'the trap is not armed').not.toBe('');
      });

      it(`through the launcher: nothing runs, the nested change is seen — ${trap.name}, ${level}`, async () => {
        const dirs = nestedRepos();
        trap.plant(dirs[level]);
        touchRepo(dirs[level]);
        await git(['add', '-A']);
        const { stdout } = await git(['status', '--porcelain']);
        expect(stdout).toMatch(/^ M nested$/m);
        await git(['diff', 'HEAD', '--', 'nested']);
        expect(fired(), 'a planted program of a nested repository ran').toBe('');
      });
    }
  }
});

describe('runInternalGit — the user’s and the system’s configuration are not read @cap:executer-une-commande/moteur', () => {
  const saved: Record<string, string | undefined> = {};
  const NAMES = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL'];

  function userHome(): string {
    const home = join(root, 'home');
    const hooks = join(home, 'hooks');
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'post-index-change');
    writeFileSync(hook, `#!/bin/sh\n${planted('user-hook')}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(
      join(home, '.gitconfig'),
      `[core]\n\thooksPath = ${fwd(hooks)}\n\tfsmonitor = ${planted('user-fsmonitor').replace(/"/g, '\\"')}\n` +
        `[status]\n\tshowUntrackedFiles = no\n`,
    );
    // The default user ignore file, read from HOME whatever the config says.
    writeFileSync(join(home, '.config', 'git', 'ignore'), '*.log\n');
    return home;
  }

  beforeEach(() => {
    for (const n of NAMES) saved[n] = process.env[n];
  });
  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('witness: a git launched directly with this HOME runs its hooks and hides what it ignores', () => {
    const home = userHome();
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'x.log'), 'log\n');
    const env = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    };
    rawGit(repo, ['add', 'a.txt'], env);
    expect(rawGit(repo, ['status', '--porcelain'], env)).not.toMatch(/x\.log/);
    expect(fired(), 'the trap is not armed').not.toBe('');
  });

  it('through the launcher: no hook, no monitor, and the status is the repository’s own', async () => {
    const home = userHome();
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'x.log'), 'log\n');
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    process.env['XDG_CONFIG_HOME'] = join(home, '.config');
    process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
    await git(['add', 'a.txt']);
    const { stdout } = await git(['status', '--porcelain']);
    expect(stdout).toMatch(/^M {2}a\.txt$/m);
    expect(stdout).toMatch(/^\?\? x\.log$/m);
    expect(fired(), 'the user configuration started a program').toBe('');
  });
});

describe('runInternalGit — the environment git actually receives @cap:executer-une-commande/moteur', () => {
  const SECRETS: Record<string, string> = {
    DATABASE_URL: 'postgres://nodal:fake-password@127.0.0.1:5432/nodal',
    WORKER_SECRET: 'fake-worker-secret',
    LLM_API_KEY: 'fake-llm-key',
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    OPENAI_API_KEY: 'fake-openai-key',
    // What would retarget or reprogram git if it were inherited.
    GIT_DIR: '/elsewhere',
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'evil',
    GIT_SSH_COMMAND: 'evil',
    GIT_EXTERNAL_DIFF: 'evil',
    GIT_ASKPASS: 'evil',
    GIT_EXEC_PATH: '/elsewhere',
  };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(SECRETS)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /**
   * A runner that launches, in place of git, a REAL process recording the
   * environment it receives: the environment the launcher hands the system
   * for a git child, byte for byte.
   */
  function recordingRunner(dump: string): ProgramRunner {
    const recorder = join(witnessDir, 'env.cjs');
    writeFileSync(
      recorder,
      `require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\n` +
        // The read of the declared keys: "none" (git's exit code 1).
        `if (process.argv[2] === 'config') process.exit(1);\n`,
    );
    return {
      execFile: (_file, args, opts) =>
        hostProgramRunner.execFile(process.execPath, [recorder, ...args], opts),
      spawn: (_file, args, opts) =>
        hostProgramRunner.spawn(process.execPath, [recorder, ...args], opts),
    };
  }

  it('holds none of the runner’s secrets, nothing that retargets git, and the fixed configuration', async () => {
    const dump = join(witnessDir, 'env.json');
    await runInternalGit(recordingRunner(dump), ['status', '--porcelain'], {
      cwd: repo,
      gitEnv: { GIT_DIR: join(repo, '.git') },
      writableRoots: [],
      readableRoots: [],
    });
    const env = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    const upper = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
    for (const name of [
      'DATABASE_URL',
      'WORKER_SECRET',
      'LLM_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GIT_CONFIG_PARAMETERS',
      'GIT_SSH_COMMAND',
      'GIT_EXTERNAL_DIFF',
      'GIT_ASKPASS',
      'GIT_EXEC_PATH',
    ]) {
      expect(upper.has(name), `${name} reached git`).toBe(false);
    }
    expect(Object.values(env).join('\n')).not.toMatch(/fake-|evil/);
    // The caller's location, not the inherited one.
    expect(upper.get('GIT_DIR')).toBe(join(repo, '.git'));
    // The fixed configuration, at command-line priority.
    expect(upper.get('GIT_CONFIG_NOSYSTEM')).toBe('1');
    expect(upper.get('GIT_CONFIG_GLOBAL')).toBe(isWindows ? 'nul' : '/dev/null');
    const count = Number(upper.get('GIT_CONFIG_COUNT'));
    const pairs = new Map(
      Array.from({ length: count }, (_, i) => [
        upper.get(`GIT_CONFIG_KEY_${i}`),
        upper.get(`GIT_CONFIG_VALUE_${i}`),
      ]),
    );
    expect(pairs.get('core.fsmonitor')).toBe('false');
    expect(pairs.get('protocol.allow')).toBe('never');
    // What a process needs to run at all is still there.
    expect(upper.get('PATH')).toBeTruthy();
  });
});

describe('runInternalGit — fails loud, never runs half-configured @cap:executer-une-commande/moteur', () => {
  /** Records every launch, and launches nothing. */
  function countingRunner(): ProgramRunner & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      execFile: async (_f, args) => {
        calls.push([...args]);
        return { stdout: '', stderr: '' };
      },
      spawn: async (_f, args) => {
        calls.push([...args]);
        throw new Error('not launched');
      },
    };
  }

  it('no git on the PATH: refused before anything starts, never the bare name', async () => {
    const runner = countingRunner();
    forcedResolution.value = null;
    try {
      await expect(
        runInternalGit(runner, ['status'], { writableRoots: [], readableRoots: [] }),
      ).rejects.toBeInstanceOf(GitBinaryMissingError);
    } finally {
      forcedResolution.value = undefined;
    }
    expect(runner.calls).toEqual([]);
  });

  it('a subcommand that is not an internal one is refused before anything starts', async () => {
    const runner = countingRunner();
    await expect(
      runInternalGit(runner, ['fetch', 'origin'], { writableRoots: [], readableRoots: [] }),
    ).rejects.toBeInstanceOf(InternalGitRefusedError);
    expect(runner.calls).toEqual([]);
  });

  it('a variable a caller may not set is refused (no secret, no override of the configuration)', async () => {
    const runner = countingRunner();
    for (const name of ['GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'DATABASE_URL']) {
      await expect(
        runInternalGit(runner, ['status'], {
          gitEnv: { [name]: 'x' },
          writableRoots: [],
          readableRoots: [],
        }),
      ).rejects.toBeInstanceOf(InternalGitRefusedError);
    }
    expect(runner.calls).toEqual([]);
  });

  it('a configuration git cannot read stops the call: the command never runs', async () => {
    rawGit(repo, ['config', 'core.fsmonitor', planted('fsmonitor')]);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    // A configuration git refuses to parse.
    writeFileSync(
      join(repo, '.git', 'config'),
      readFileSync(join(repo, '.git', 'config'), 'utf8') + '\n[broken\n',
    );
    await expect(git(['status', '--porcelain'])).rejects.toBeInstanceOf(GitConfigUnreadableError);
    expect(fired()).toBe('');
  });
});

describe('overridesForDeclaredKeys — every name a repository declares is neutralised @cap:executer-une-commande/moteur', () => {
  it('empties each program and keeps the names as git prints them', () => {
    const out = [
      'filter.Lfs.clean\ngit-lfs clean -- %f',
      'filter.Lfs.smudge\ngit-lfs smudge -- %f',
      'diff.external\nsomething',
      'diff.word.textconv\nantiword',
      'merge.ours.driver\ntrue',
      'hook.lint.command\nnpm run lint',
      'protocol.foo.allow\nalways',
      '',
    ].join('\0');
    expect(overridesForDeclaredKeys(out)).toEqual([
      ['filter.Lfs.clean', ''],
      ['filter.Lfs.required', 'false'],
      ['filter.Lfs.smudge', ''],
      ['diff.external', ''],
      ['diff.word.textconv', ''],
      ['merge.ours.driver', ''],
      ['hook.lint.enabled', 'false'],
      ['protocol.foo.allow', 'never'],
    ]);
  });

  it('refuses a repository that declares more than it can neutralise', () => {
    const many = Array.from({ length: 300 }, (_, i) => `merge.d${i}.driver\nx`).join('\0');
    expect(() => overridesForDeclaredKeys(many)).toThrow(GitConfigUnreadableError);
  });

  it('the declared overrides come after the fixed ones, so they win over the repository', () => {
    const env = internalGitEnvironment({ PATH: '/bin' }, {}, [['filter.x.clean', '']]);
    const count = Number(env['GIT_CONFIG_COUNT']);
    expect(env[`GIT_CONFIG_KEY_${count - 1}`]).toBe('filter.x.clean');
    expect(env[`GIT_CONFIG_VALUE_${count - 1}`]).toBe('');
  });
});
