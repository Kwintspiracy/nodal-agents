// internal-git.ts — THE launcher of every git process Nodal starts for itself.
//
// Nodal runs git on its own, without any agent asking: to describe a job's
// first folder, to take a checkpoint before a mutating tool call and restore
// it, to read what a call wrote, to show changes on the dashboard, to set up a
// project. These git processes run in folders that agents write. So the rule
// is one, and it lives here, for every caller, every operating system, with
// the sandbox on, off or absent:
//
//   A git process that Nodal starts for itself never executes anything a
//   repository says, never reads the user's or the system's git
//   configuration, and never receives Nodal's secrets.
//
// It is held by three things, all set by `runInternalGit` / `spawnInternalGit`
// and by nothing else:
//
//   1. THE ENVIRONMENT is the scrubbed allowlist that every process agents
//      start already gets (`buildChildEnv`, `./child-env`), plus git's own
//      fixed variables (`FIXED_GIT_ENV`), plus the repository location and the
//      commit identity a caller names (`CALLER_GIT_ENV`, an allowlist). The
//      runner's database address, its worker secret and the model keys are not
//      in it: they are not in the allowlist.
//   2. A FIXED CONFIGURATION (`FIXED_GIT_CONFIG`), passed through
//      `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`. That
//      channel has the priority of `git -c`, above every configuration file,
//      and git hands it to the git processes it starts itself (the one that
//      checks a nested repository, for instance). Global and system
//      configuration are not read at all (`GIT_CONFIG_GLOBAL`,
//      `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`).
//   3. THE NAMES A REPOSITORY CHOOSES. Filter, diff and merge drivers, and
//      configured hooks, are keyed by a name the repository picks: no fixed
//      key can switch them off. Before each call, the same launcher reads the
//      keys the repository declares (`DECLARED_PROGRAM_KEYS`, one bounded
//      `git config` in the same folder, the same environment, the same
//      sandbox) and overrides each one. A command that checks NESTED
//      repositories (`add`, `status`, `diff` start a child git in each
//      gitlink of the index) gets the names those repositories declare too,
//      read the same way in each of them, recursively: the child inherits the
//      overrides with the rest of the environment. If a read fails, the call
//      fails: git never runs with half of this.
//
// WHAT REMAINS POSSIBLE, said here because no switch of git closes it: the
// names of step 3 are read just before the call. A configuration written
// between that read and the call is not in it. That window is closed by
// keeping repository metadata out of reach of agent writes, a separate
// decision; the fixed keys of step 2 do not depend on it.
//
// Only the subcommands of `INTERNAL_GIT_COMMANDS` are launched: the fixed
// configuration was checked against git-config(1) for what THESE commands can
// start. A command outside the list (fetch, gc, send-email…) could reach keys
// this file does not pin, so it is refused until someone adds it here and
// re-reads git-config(1) for it.
//
// A git spawned anywhere else is refused by the architecture tests
// (`scanForGitSpawnOutsideLauncher`, @nodal-agents/test-kit).
//
// Served by a sub-path (`@nodal-agents/shared/internal-git`), never by the
// index: it touches `node:child_process`, and browser components import the
// index.

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { buildChildEnv } from './child-env';
import { resolveGitBinary } from './git-binary';

// ─── How a program is launched (host or sandbox) ─────────────────────────────

/** What ONE launch receives. The environment is always explicit. */
export interface ProgramLaunch {
  readonly cwd?: string;
  /** The EXACT environment of the program: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** What the program must be able to WRITE (none for a read). */
  readonly writableRoots: readonly string[];
  /** What it must be able to READ, even under the refused data folder. */
  readonly readableRoots: readonly string[];
}

/** A program started as a stream. */
export interface ProgramChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Asks it to stop. Idempotent. */
  kill(): void;
  /** Its end: the exit code, `null` when it was killed. Never rejects. */
  readonly closed: Promise<{ code: number | null }>;
}

/**
 * Where a program runs: on the host (`hostProgramRunner`) or in the sandbox
 * (`openNodalPrograms`, @nodal-agents/sandbox). The shape of `execFile` and
 * `spawn`.
 */
export interface ProgramRunner {
  /**
   * Like `execFile` (UTF-8 text output): rejects on a non-zero exit
   * (`err.code` = the code), a bound reached (`err.killed` = true), or a launch
   * that cannot happen (the system's error, or the sandbox's).
   */
  execFile(
    file: string,
    args: readonly string[],
    opts: ProgramLaunch & { readonly timeout?: number; readonly maxBuffer?: number },
  ): Promise<{ stdout: string; stderr: string }>;
  /** Starts it as a stream; rejects when it cannot start. */
  spawn(file: string, args: readonly string[], opts: ProgramLaunch): Promise<ProgramChild>;
}

/**
 * The environment as Node's `child_process` types it. A cast, not a
 * conversion: some apps (Next.js) augment `NodeJS.ProcessEnv` with required
 * fields, which a plain record of strings cannot have, and Node accepts any
 * record of strings here.
 */
const asProcessEnv = (env: Readonly<Record<string, string>>): NodeJS.ProcessEnv =>
  env as NodeJS.ProcessEnv;

/**
 * Programs on the host: Node's `execFile` and `spawn`, with the environment
 * given and nothing else (`env` is never merged with the process's own).
 */
export const hostProgramRunner: ProgramRunner = {
  execFile(file, args, opts) {
    return new Promise((resolve, reject) => {
      nodeExecFile(
        file,
        [...args],
        {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          env: asProcessEnv(opts.env),
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
  },
  spawn(file, args, opts) {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn(file, [...args], {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env: asProcessEnv(opts.env),
        windowsHide: true,
      });
      const closed = new Promise<{ code: number | null }>((r) =>
        child.on('close', (code) => r({ code })),
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.off('error', reject);
        child.on('error', () => undefined); // a late error ends in `close`
        resolve({ stdout: child.stdout, stderr: child.stderr, kill: () => child.kill(), closed });
      });
    });
  },
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/** No `git` on the PATH: the launcher never falls back to the bare name. */
export class GitBinaryMissingError extends Error {
  readonly code = 'GIT_NOT_ON_PATH';
  constructor() {
    super(
      'git is not on PATH (GIT_NOT_ON_PATH): install git, or make it reachable from the process PATH.',
    );
    this.name = 'GitBinaryMissingError';
  }
}

/** A call this launcher does not make: a programming error, said loudly. */
export class InternalGitRefusedError extends Error {
  readonly code = 'INTERNAL_GIT_REFUSED';
  constructor(detail: string) {
    super(`INTERNAL_GIT_REFUSED: ${detail}`);
    this.name = 'InternalGitRefusedError';
  }
}

/**
 * The keys a repository declares could not be read: the call does not run
 * (step 3 of the header — git never runs with half of its configuration).
 */
export class GitConfigUnreadableError extends Error {
  readonly code = 'GIT_CONFIG_UNREADABLE';
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`GIT_CONFIG_UNREADABLE: ${detail}`, options);
    this.name = 'GitConfigUnreadableError';
  }
}

// ─── The fixed environment and configuration ─────────────────────────────────

const WINDOWS = process.platform === 'win32';

/**
 * A configuration FILE that is always empty. On Windows git opens `nul` as
 * the null device (measured with git 2.55: `\\.\nul` is refused as a config
 * path); elsewhere `/dev/null`.
 */
const EMPTY_FILE = WINDOWS ? 'nul' : '/dev/null';

/**
 * A hooks DIRECTORY under which nothing can ever exist: git looks for
 * `<dir>/<hook>`. `/dev/null` is a device, so `/dev/null/x` is never a file;
 * on Windows the device namespace (`\\.\nul`) has no children either. A
 * relative `nul` would be resolved against the folder git runs in, which an
 * agent writes: never that.
 */
const NO_HOOKS_DIR = WINDOWS ? '\\\\.\\nul' : '/dev/null';

/**
 * Git's own variables, the same on every machine. Each one closes a door git
 * documents in git(1) "ENVIRONMENT VARIABLES".
 */
const FIXED_GIT_ENV: Readonly<Record<string, string>> = {
  // No system or user configuration: Nodal's git behaves the same on every
  // machine, and a user's `~/.gitconfig` cannot start a program in it.
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: EMPTY_FILE,
  GIT_CONFIG_GLOBAL: EMPTY_FILE,
  // No system attributes file ($(prefix)/etc/gitattributes).
  GIT_ATTR_NOSYSTEM: '1',
  // Never prompt: there is nobody to answer, and a prompt is a hang.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  // `cat` is git's own "no pager" value and `:` its own "no editor" value:
  // git recognises both and starts NOTHING (pager.c, editor.c). They take
  // precedence over `core.pager`, `pager.<cmd>` and `core.editor`.
  GIT_PAGER: 'cat',
  GIT_EDITOR: ':',
  GIT_SEQUENCE_EDITOR: ':',
  // A partial clone never downloads a missing object behind Nodal's back
  // (git >= 2.44; every transport is refused below anyway).
  GIT_NO_LAZY_FETCH: '1',
  // Nodal's git reads a repository's state and never rewrites its index as a
  // side effect: with the repository's filters neutralised (step 3), a
  // refreshed index would record what the repository's own git would not.
  // `add` takes the index lock it needs: that lock is not optional.
  GIT_OPTIONAL_LOCKS: '0',
};

/** The protocols git(1) names; any other is refused by `protocol.allow`. */
const PROTOCOLS = ['file', 'git', 'ssh', 'http', 'https', 'ext'] as const;

/**
 * The fixed configuration, decided from git-config(1) (git 2.55) for the
 * commands of `INTERNAL_GIT_COMMANDS`. Every key that names a program, or
 * decides whether git starts one, is pinned here or reached by step 3.
 */
const FIXED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // The file-system monitor: a program `status`, `add` and `diff` start to
  // ask what changed.
  ['core.fsmonitor', 'false'],
  // The hooks directory (`$GIT_DIR/hooks`): a path under which nothing exists.
  // It does not reach the hooks a configuration declares (`hook.<name>.command`,
  // measured): those are switched off by name, in step 3.
  ['core.hooksPath', NO_HOOKS_DIR],
  // Pager and editors: git's own "none" values (see FIXED_GIT_ENV).
  ['core.pager', 'cat'],
  ['core.editor', ':'],
  ['sequence.editor', ':'],
  // No credential helper (an empty value resets the list) and no askpass
  // program (an empty value means none).
  ['credential.helper', ''],
  ['core.askPass', ''],
  // No transport at all, so no ssh command, proxy command, upload-pack or
  // receive-pack program, remote helper or `ext::` command can start. Each
  // known protocol is pinned too, because `protocol.<name>.allow` in a
  // repository would win over `protocol.allow`; the other names a repository
  // declares are pinned by step 3.
  ['protocol.allow', 'never'],
  ...PROTOCOLS.map((p) => [`protocol.${p}.allow`, 'never'] as const),
  // No signature-checking program: `log` verifies signatures when
  // `log.showSignature` says so. (`commit-tree` signs only when given `-S`,
  // which no caller passes: git-commit-tree(1) reads no signing setting.)
  ['log.showSignature', 'false'],
  // No automatic gc or maintenance child (and so no `gc.recentObjectsHook`).
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  // No recursion into nested repositories beyond the check git itself makes
  // (that child inherits this configuration).
  ['submodule.recurse', 'false'],
  ['status.submoduleSummary', 'false'],
  // No user-level attributes or ignore file (their default paths are under
  // HOME, read whatever GIT_CONFIG_GLOBAL says): the same on every machine.
  ['core.attributesFile', EMPTY_FILE],
  ['core.excludesFile', EMPTY_FILE],
];

/**
 * The variables a caller may set: where the repository is, and who signs a
 * commit Nodal makes. Anything else is refused: a caller cannot hand git a
 * secret, nor undo the fixed configuration.
 */
const CALLER_GIT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

/**
 * The subcommands Nodal's git runs. The fixed configuration was checked
 * against git-config(1) for these; see the header.
 */
export const INTERNAL_GIT_COMMANDS: ReadonlySet<string> = new Set([
  'add',
  'cat-file',
  'checkout',
  'commit-tree',
  'diff',
  'init',
  'log',
  'ls-files',
  'ls-tree',
  'rev-list',
  'rev-parse',
  'status',
  'update-ref',
  'verify-pack',
  'write-tree',
]);

/**
 * The commands that CREATE a repository and read none: there are no declared
 * keys to read (step 3) because no repository's configuration is opened, and
 * reading them would search the folders above for a repository the command
 * never uses (measured: in the sandbox that search reaches a folder the
 * container cannot enter, and fails). No repository key starts a program in
 * `init`: it runs no hook, no filter, no file-system monitor.
 */
const CREATES_REPOSITORY: ReadonlySet<string> = new Set(['init']);

/**
 * The switches git(1) gives a command to start NO diff program: an external
 * diff (`diff.external`, `diff.<name>.command`) and a text conversion
 * (`diff.<name>.textconv`). Git has no configuration value meaning "none" for
 * these (an empty one makes it refuse to diff, measured), so the commands
 * that produce a diff are always given them, right after their name. Step 3
 * still empties those keys: a second wall, never the only one.
 */
const NO_DIFF_PROGRAMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['diff', ['--no-ext-diff', '--no-textconv']],
  ['log', ['--no-ext-diff', '--no-textconv']],
]);

// ─── Step 3: the names a repository declares ─────────────────────────────────

/**
 * The keys whose NAME the repository chooses, or that git offers no "off"
 * value for:
 *   - `filter.<name>.clean|smudge|process`: a filter program;
 *   - `diff.external`, `diff.<name>.command|textconv`: a diff program
 *     (an empty value is not "none" for these: git then refuses to diff,
 *     measured, a loud failure and never a program; `NO_DIFF_PROGRAMS` keeps
 *     Nodal's own diffs from reaching them at all);
 *   - `merge.<name>.driver`: a merge program;
 *   - `hook.<name>.command`: a configured hook;
 *   - `protocol.<name>.allow`: a transport the repository allows.
 */
const DECLARED_PROGRAM_KEYS =
  '^(filter\\..+\\.(clean|smudge|process)|diff\\.external|diff\\..+\\.(command|textconv)|merge\\..+\\.driver|hook\\..+\\.command|protocol\\..+\\.allow)$';

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/i;
const HOOK_KEY = /^hook\.(.+)\.command$/i;
const PROTOCOL_KEY = /^protocol\.(.+)\.allow$/i;

/**
 * Each override costs two environment entries; a repository declaring tens of
 * thousands would make every launch fail with E2BIG. Past this, the call is
 * refused (fail loud) instead of running with part of them.
 */
const MAX_DECLARED_KEYS = 256;

/** A bound for the read when the call itself has none (a streamed call). */
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * The overrides for what the repository declares, from the NUL-separated
 * output of `git config -z --get-regexp` (`key\nvalue\0` per entry).
 * Exported for its test.
 */
export function overridesForDeclaredKeys(output: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  const add = (key: string, value: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push([key, value]);
  };
  for (const entry of output.split('\0')) {
    const key = entry.split('\n', 1)[0]!.trim();
    if (key === '') continue;
    const filter = FILTER_KEY.exec(key);
    if (filter) {
      // An empty filter command is no filter (convert.c), and a filter that
      // is not required is skipped instead of failing the call.
      add(key, '');
      add(`filter.${filter[1]}.required`, 'false');
      continue;
    }
    const hook = HOOK_KEY.exec(key);
    if (hook) {
      add(`hook.${hook[1]}.enabled`, 'false');
      continue;
    }
    if (PROTOCOL_KEY.test(key)) {
      add(key, 'never');
      continue;
    }
    // diff.external, diff.<name>.command|textconv, merge.<name>.driver.
    add(key, '');
  }
  if (out.length > MAX_DECLARED_KEYS) {
    throw new GitConfigUnreadableError(
      `the repository declares ${out.length} program keys, more than ${MAX_DECLARED_KEYS}`,
    );
  }
  return out;
}

/**
 * The environment of one internal git: the scrubbed allowlist, git's fixed
 * variables, the caller's location and identity, and the configuration
 * (fixed, then the overrides of what the repository declares). Exported for
 * its test; `runInternalGit` is the only production caller.
 */
export function internalGitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  gitEnv: Readonly<Record<string, string>>,
  declared: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  for (const name of Object.keys(gitEnv)) {
    if (!CALLER_GIT_ENV.has(name)) {
      throw new InternalGitRefusedError(`the variable ${name} is not one a caller may set`);
    }
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(buildChildEnv(source))) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, FIXED_GIT_ENV, gitEnv);
  const config = [...FIXED_GIT_CONFIG, ...declared];
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  env['GIT_CONFIG_COUNT'] = String(config.length);
  return env;
}

// ─── The launcher ────────────────────────────────────────────────────────────

/** What a caller says about ONE internal git. */
export interface InternalGitOptions {
  readonly cwd?: string;
  /** The repository location and commit identity (`CALLER_GIT_ENV`). */
  readonly gitEnv?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly maxBuffer?: number;
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
}

interface Prepared {
  readonly binary: string;
  /** The arguments as launched (the command's own switches added). */
  readonly args: readonly string[];
  readonly launch: ProgramLaunch;
}

/** A launch for one of the launcher's own reads (step 3). */
type ReadLaunch = Omit<ProgramLaunch, 'env'> & { readonly timeout: number };

/**
 * Runs one of step 3's reads. Exit code 1 is git's "nothing found" for
 * `config --get-regexp`, and is returned as an empty output. Any other answer
 * of git is a read that failed: the call does not run without it. A bound
 * reached, a git that could not start, a sandbox that refused: the same
 * failure the call itself would have, said as itself, so a caller tells a
 * timeout from a missing git as it always did.
 */
async function read(
  runner: ProgramRunner,
  binary: string,
  args: readonly string[],
  launch: ReadLaunch & { readonly env: Readonly<Record<string, string>> },
  noneIsExitOne: boolean,
): Promise<string> {
  try {
    const { stdout } = await runner.execFile(binary, args, {
      ...launch,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean };
    if (noneIsExitOne && e.code === 1 && e.killed !== true) return '';
    if (typeof e.code === 'number' && e.killed !== true) {
      throw new GitConfigUnreadableError(
        `git ${args[0]} for the repository's program keys failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** The overrides for what ONE repository's configuration declares. */
async function declaredIn(
  runner: ProgramRunner,
  binary: string,
  launch: ReadLaunch,
  gitEnv: Readonly<Record<string, string>>,
): Promise<Array<readonly [string, string]>> {
  const out = await read(
    runner,
    binary,
    ['config', '--includes', '-z', '--get-regexp', DECLARED_PROGRAM_KEYS],
    { ...launch, env: internalGitEnvironment(process.env, gitEnv, []) },
    true,
  );
  return overridesForDeclaredKeys(out);
}

/** Git's mode for a nested repository recorded in an index (a gitlink). */
const GITLINK_MODE = '160000';

/**
 * The nested repositories git will check from this index: its gitlinks whose
 * folder holds a repository (`<path>/.git`). Measured (git 2.55): `add`,
 * `status` and `diff` start a child git in each of them, and only in them (an
 * untracked nested repository is not entered).
 */
async function nestedRepositories(
  runner: ProgramRunner,
  binary: string,
  launch: ReadLaunch,
  gitEnv: Readonly<Record<string, string>>,
): Promise<string[]> {
  const env = internalGitEnvironment(process.env, gitEnv, []);
  const listed = await read(
    runner,
    binary,
    ['ls-files', '-s', '-z', '--full-name', '--', ':/'],
    { ...launch, env },
    false,
  );
  const paths = listed
    .split('\0')
    .filter((entry) => entry.startsWith(`${GITLINK_MODE} `))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1));
  if (paths.length === 0) return [];
  const top =
    gitEnv['GIT_WORK_TREE'] ??
    (
      await read(runner, binary, ['rev-parse', '--show-toplevel'], { ...launch, env }, false)
    ).replace(/\r?\n$/, '');
  return paths.map((p) => join(top, p)).filter((dir) => existsSync(join(dir, '.git')));
}

/**
 * A child git checks a nested repository with that repository's own
 * configuration, and its children check theirs: the names are read in each,
 * down to this depth and up to this many repositories (beyond, the call is
 * refused rather than run with part of them).
 */
const MAX_NESTED_DEPTH = 8;
const MAX_NESTED_REPOSITORIES = 64;

/** The commands that start a child git in each nested repository (see above). */
const ENTERS_NESTED_REPOSITORIES: ReadonlySet<string> = new Set(['add', 'diff', 'status']);

/** The names every nested repository the command will check declares. */
async function declaredInNested(
  runner: ProgramRunner,
  binary: string,
  launch: ReadLaunch,
  gitEnv: Readonly<Record<string, string>>,
): Promise<Array<readonly [string, string]>> {
  const found: Array<readonly [string, string]> = [];
  let level = await nestedRepositories(runner, binary, launch, gitEnv);
  let seen = 0;
  for (let depth = 0; level.length > 0; depth++) {
    seen += level.length;
    if (depth >= MAX_NESTED_DEPTH || seen > MAX_NESTED_REPOSITORIES) {
      throw new GitConfigUnreadableError(
        `more nested repositories than can be read (depth ${MAX_NESTED_DEPTH}, ${MAX_NESTED_REPOSITORIES} repositories)`,
      );
    }
    const next: string[] = [];
    for (const dir of level) {
      // A nested repository: its own folder, none of the caller's locations.
      const inside: ReadLaunch = { ...launch, cwd: dir };
      found.push(...(await declaredIn(runner, binary, inside, {})));
      next.push(...(await nestedRepositories(runner, binary, inside, {})));
    }
    level = next;
  }
  return found;
}

async function prepare(
  runner: ProgramRunner,
  args: readonly string[],
  opts: InternalGitOptions,
): Promise<Prepared> {
  const command = args[0];
  if (command === undefined || !INTERNAL_GIT_COMMANDS.has(command)) {
    throw new InternalGitRefusedError(
      `git ${command ?? '(no command)'} is not an internal command`,
    );
  }
  // The ABSOLUTE path of the system's git, never the bare name (#251).
  const binary = await resolveGitBinary();
  if (binary === null) throw new GitBinaryMissingError();
  const gitEnv = opts.gitEnv ?? {};
  const launched = [command, ...(NO_DIFF_PROGRAMS.get(command) ?? []), ...args.slice(1)];
  const base = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    writableRoots: opts.writableRoots,
    readableRoots: opts.readableRoots,
  };
  if (CREATES_REPOSITORY.has(command)) {
    return {
      binary,
      args: launched,
      launch: { ...base, env: internalGitEnvironment(process.env, gitEnv, []) },
    };
  }
  // Step 3, in the same folder, environment and sandbox as the call itself:
  // the repository's own names and, for a command that enters them, those of
  // every nested repository it will check.
  const readLaunch: ReadLaunch = { ...base, timeout: opts.timeout ?? DISCOVERY_TIMEOUT_MS };
  const [mine, theirs] = await Promise.all([
    declaredIn(runner, binary, readLaunch, gitEnv),
    ENTERS_NESTED_REPOSITORIES.has(command)
      ? declaredInNested(runner, binary, readLaunch, gitEnv)
      : Promise.resolve([]),
  ]);
  const declared: Array<readonly [string, string]> = [];
  const keys = new Set<string>();
  for (const [key, value] of [...mine, ...theirs]) {
    if (keys.has(key)) continue;
    keys.add(key);
    declared.push([key, value]);
  }
  if (declared.length > MAX_DECLARED_KEYS) {
    throw new GitConfigUnreadableError(
      `the repositories declare ${declared.length} program keys, more than ${MAX_DECLARED_KEYS}`,
    );
  }
  return {
    binary,
    args: launched,
    launch: { ...base, env: internalGitEnvironment(process.env, gitEnv, declared) },
  };
}

/**
 * Runs ONE internal git and returns its output (UTF-8). Rejects like
 * `execFile` on a non-zero exit, a bound reached, or a launch that cannot
 * happen; with `GitBinaryMissingError` when git is not on the PATH, with
 * `GitConfigUnreadableError` when the repository's keys cannot be read.
 */
export async function runInternalGit(
  runner: ProgramRunner,
  args: readonly string[],
  opts: InternalGitOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { binary, args: launched, launch } = await prepare(runner, args, opts);
  return runner.execFile(binary, launched, {
    ...launch,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  });
}

/** Starts ONE internal git as a stream (same rules as `runInternalGit`). */
export async function spawnInternalGit(
  runner: ProgramRunner,
  args: readonly string[],
  opts: Omit<InternalGitOptions, 'maxBuffer'>,
): Promise<ProgramChild> {
  const { binary, args: launched, launch } = await prepare(runner, args, opts);
  return runner.spawn(binary, launched, launch);
}
