// builtin/command-allowlist.ts — the per-agent command allowlist.
//
// WHY THIS EXISTS. `run_command` had exactly two controls: the per-agent
// `command-execution` skill (which decides IF the agent gets a shell) and the
// approval gate (which asks a human before each command). Neither of them can
// say "this agent may run `node` and `npx vitest`, and nothing else" — so an
// agent whose job needs to EXECUTE a snippet to check a claim had to be given,
// unattended, a shell that can do anything. That is the gap this closes.
//
// HOW, AND WHY IT CHANGED. The first design kept the shell and scanned the
// command string for what the shell would do with it. Five review passes found
// five holes in that scanner, each a construct cmd.exe reads unlike the scan:
// `2>&1` split as a separator, a separator inside quotes, the single quote
// (which cmd.exe does not treat as a string), a program planted in the working
// directory, and the caret escape. A sixth was always coming, because the
// scanner was trying to be a second implementation of cmd.exe.
//
// So the shell is gone. WITH A LIST SET, `run_command` starts ONE program with
// ITS ARGUMENTS and no shell at all: `shell: false`, argv literal, nothing to
// interpolate, nothing to chain, nothing to redirect, nothing to expand. The
// command line is read by `tokenizeSimpleCommand` below — spaces separate,
// double quotes group, and that is the entire grammar. Anything else is
// REFUSED with the character named, so the agent can rewrite its command.
//
// WITHOUT A LIST (`NULL`) nothing changes: the shell, everything it allows,
// and the approval gate as the control. That path is not this module's
// business.
//
// WHAT IT IS NOT. Still not a sandbox. `node` can open a socket, read outside
// the workspace and write files; the allowlist restricts WHICH PROGRAM starts,
// not what that program may then do.
//
// WHAT IT GOVERNS, AND WHAT IT DOES NOT. `run_command`, and nothing else.
// `run_skill_script`, `code_task` (the Claude Code / Codex CLIs) and the
// `verify_commands` of `declare_verification` all start processes WITHOUT
// consulting this list — verified by grepping `commandAllowlist` across the
// repo. An owner who sets `['node']` has narrowed one door, not confined the
// agent.
//
// A SHELL ON THE LIST IS A LIST THAT MEANS NOTHING. `cmd` reads as "this agent
// may run cmd" and grants `cmd /c <anything>`. The set is `SHELL_PROGRAMS`
// (`@nodal-agents/shared`) and the settings action refuses such an entry when
// the owner SAVES it. Nothing re-checks it here.
//
// The list is DATA on the agent row (`agents.command_allowlist`), never a
// hardcoded per-agent branch — invariant #1. It is read ONCE per job, when the
// runner loads the agent row (`apps/runner/src/job/execute.ts`), and the same
// value is reused when the job resumes after an approval: tightening a list
// mid-job does not apply to the job already running.

import { delimiter, isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';

/** Thrown when a command is refused. Fails loud — invariant #4. */
export class CommandNotAllowedError extends Error {
  readonly code = 'command_not_allowed';
  constructor(
    readonly refused: string,
    readonly allowlist: readonly string[],
    /** Why it was refused, when the reason is not simply "absent from the list". */
    readonly reason?: string,
  ) {
    super(
      `Command refused: "${refused}" is not on this agent's command allowlist. ` +
        `Allowed: ${allowlist.length > 0 ? allowlist.map((e) => `"${e}"`).join(', ') : '(nothing)'}.` +
        (reason ? ` ${reason}` : ''),
    );
    this.name = 'CommandNotAllowedError';
  }
}

/**
 * Characters the simple reader does not understand, OUTSIDE double quotes.
 *
 * Every one of them means something to a shell and nothing here, because no
 * shell runs. Rather than silently passing `&&` to a program as a literal
 * argument — which would look like it worked and quietly do the wrong thing —
 * the command is refused and the character is named. An agent that reads the
 * error rewrites its command; that is the whole point of naming it.
 *
 * INSIDE double quotes they are ordinary characters, because there is nothing
 * to protect against: `node -e "console.log(1>2)"` passes `console.log(1>2)`
 * to node, and the `>` never reaches anything that would read it.
 */
const UNREADABLE_OUTSIDE_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['&', 'chaining or backgrounding (&, &&)'],
  ['|', 'a pipe (|, ||)'],
  [';', 'a command separator (;)'],
  ['>', 'a redirection (>)'],
  ['<', 'a redirection (<)'],
  ['%', 'a cmd.exe variable (%NAME%)'],
  ['$', 'a shell variable ($NAME)'],
  ['`', 'command substitution (backtick)'],
  ['^', "cmd.exe's escape character (^)"],
  ["'", 'a single quote — use double quotes to group an argument'],
  ['\n', 'a line break'],
  ['\r', 'a line break'],
];

/**
 * Which shell (if any) `run-command.ts` will spawn. Read at call time, not
 * captured at module load: a test must be able to prove both platforms' rules
 * from one machine.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Read a command line as ONE program and its arguments.
 *
 * The entire grammar: whitespace separates tokens, a double quote groups what
 * follows until the next double quote. No escapes, no single quotes, no
 * variables, no separators, no redirections. Deliberately small enough to hold
 * in your head — the previous design's scanner was not, and that is what let
 * five holes through.
 *
 * Throws `CommandNotAllowedError` naming what it could not read.
 */
export function tokenizeSimpleCommand(command: string, allowlist: readonly string[]): string[] {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let inQuotes = false;

  const end = (): void => {
    if (started) {
      tokens.push(token);
      token = '';
      started = false;
    }
  };

  for (const c of command) {
    if (inQuotes) {
      if (c === '"') inQuotes = false;
      else {
        token += c;
        started = true;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true; // `node -e ""` passes an empty argument, not nothing
      continue;
    }
    const unreadable = UNREADABLE_OUTSIDE_QUOTES.find(([ch]) => ch === c);
    if (unreadable) {
      throw new CommandNotAllowedError(
        command.trim(),
        allowlist,
        `This command cannot be read: it contains ${unreadable[1]}. With a command allowlist ` +
          'there is NO SHELL — one program, its arguments, double quotes to group. Rewrite it ' +
          'without that character.',
      );
    }
    if (c === ' ' || c === '\t') {
      end();
      continue;
    }
    token += c;
    started = true;
  }

  if (inQuotes) {
    throw new CommandNotAllowedError(
      command.trim(),
      allowlist,
      'This command cannot be read: a double quote is never closed.',
    );
  }
  end();
  return tokens;
}

/**
 * An entry matches when its tokens equal the command's leading tokens.
 *
 * The FIRST token is the PROGRAM, and on Windows one program has several
 * spellings: PATH resolves `npx` to `npx.cmd`, the shell is case-insensitive,
 * and an agent writing `node.exe` means `node`. Comparing it case-insensitively
 * and without a `.exe` / `.cmd` / `.bat` suffix THERE is what the OS does.
 * Elsewhere, where case and suffix are meaningful, the comparison stays exact.
 *
 * ARGUMENTS after the program are compared exactly on every platform: to npx,
 * `vitest` and `VITEST` are different package names.
 */
function matches(entry: readonly string[], tokens: readonly string[]): boolean {
  if (tokens.length < entry.length) return false;
  if (normalizeProgram(entry[0]!) !== normalizeProgram(tokens[0]!)) return false;
  for (let i = 1; i < entry.length; i++) {
    if (entry[i] !== tokens[i]) return false;
  }
  return true;
}

function normalizeProgram(token: string): string {
  if (!isWindows()) return token;
  return token.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * An allowlist entry is written by a human in the agent settings, not produced
 * by a shell: splitting on whitespace is the whole job.
 */
function tokenizeEntry(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * Refuse `command` unless it reads as one program on `allowlist`.
 *
 * `null` / `undefined` = no allowlist configured: unchanged, unrestricted
 * behaviour, and the command goes to a shell. An EMPTY ARRAY is a decision,
 * not an absence — it refuses everything.
 *
 * Returns the tokens, so the caller does not read the line twice.
 */
export function assertCommandAllowed(
  command: string,
  allowlist: readonly string[] | null | undefined,
): readonly string[] | null {
  if (allowlist === null || allowlist === undefined) return null;

  const tokens = tokenizeSimpleCommand(command, allowlist);
  if (tokens.length === 0) {
    throw new CommandNotAllowedError(command.trim(), allowlist, 'It names no program.');
  }

  const entries = allowlist
    .map((entry) => tokenizeEntry(entry))
    .filter((entryTokens) => entryTokens.length > 0);
  if (!entries.some((entry) => matches(entry, tokens))) {
    throw new CommandNotAllowedError(command.trim(), allowlist);
  }
  return tokens;
}

// ─── Finding the program, on the PATH and nowhere else ───────────────────────

/**
 * The ONLY extensions this module resolves on Windows, in the order it prefers
 * them. Not the PATHEXT: PATHEXT lists everything `cmd.exe` knows how to hand
 * to some interpreter, and we are not `cmd.exe`.
 *
 * `.exe` and `.com` are spawned directly; `.cmd` and `.bat` go through the
 * batch line below. Everything else — `.js`, `.vbs`, `.ps1`, `.msc` — is NOT
 * launchable here, so resolving it would only trade a clear refusal for a raw
 * spawn error from Node. An earlier version unioned the default PATHEXT and
 * did exactly that: a `node.js` sitting earlier on the PATH than `node.exe`
 * resolved, then failed to spawn.
 *
 * So a same-named file with any other extension is IGNORED, and the search
 * carries on down the PATH. If nothing launchable is found the command is
 * refused with "not found on the PATH", which is the truth: nothing the
 * allowlist can start is there.
 */
const LAUNCHABLE_WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** What to spawn, once the command has been read and allowed. */
export interface AllowedSpawn {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * Windows only, and only for a `.cmd` / `.bat`: the arguments are already a
   * finished command line and Node must not re-quote them.
   */
  readonly windowsVerbatimArguments?: boolean;
}

/**
 * Resolve `program` against the PATH, and NOWHERE else.
 *
 * The working directory is never searched. That closes, by construction, the
 * hole a previous pass had to guard against with a directory scan: an agent
 * writing `node.cmd` into its own workspace and having `node x.js` start it.
 * There is nothing to scan when the resolver cannot see the workspace.
 *
 * An empty PATH entry and a literal `.` are dropped for the same reason: both
 * mean "the current directory".
 */
function resolveOnPath(program: string, env: Record<string, string | undefined>): string | null {
  const directories = (env['PATH'] ?? env['Path'] ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== '.' && isAbsolute(entry));

  // On Windows an extensionless file is NOT executable: CreateProcess needs an
  // extension, which is why `cmd.exe` appends one. Trying the bare name first
  // would pick up the extensionless `npx` shell script that ships next to
  // `npx.cmd` for Git Bash — measured here — and hand Node a file it cannot
  // spawn. So the bare name is tried only when it already carries one of the
  // extensions we can actually launch.
  const extensions: readonly string[] = isWindows() ? LAUNCHABLE_WINDOWS_EXTENSIONS : [];
  const alreadyLaunchable =
    !isWindows() || extensions.some((ext) => program.toLowerCase().endsWith(ext));
  const candidates = alreadyLaunchable ? [program] : extensions.map((ext) => `${program}${ext}`);

  for (const directory of directories) {
    for (const candidate of candidates) {
      const full = join(directory, candidate);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** A double quote or a caret inside an argument would end the line we build. */
const BREAKS_A_BATCH_LINE = /["^]/;

/**
 * Turn an allowed command into what `shell-engine.ts` should spawn — or return
 * `null` when there is no allowlist, meaning the caller keeps the shell.
 *
 * Throws `CommandNotAllowedError` when the command cannot be read, is not on
 * the list, or names a program the PATH does not hold.
 */
export function planAllowedRun(
  command: string,
  allowlist: readonly string[] | null | undefined,
  env: Record<string, string | undefined>,
): AllowedSpawn | null {
  const tokens = assertCommandAllowed(command, allowlist);
  if (tokens === null) return null;
  const list = allowlist as readonly string[];

  const program = tokens[0]!;
  const args = tokens.slice(1);

  // A path is not a program on the PATH. Refused for the same reason the
  // matcher refuses it: an entry names something the OS finds, not a file the
  // agent may have written itself.
  if (/[/\\:]/.test(program)) {
    throw new CommandNotAllowedError(
      command.trim(),
      list,
      'A path is not allowed here: name a program the PATH resolves, not a file.',
    );
  }

  const resolved = resolveOnPath(program, env);
  if (resolved === null) {
    throw new CommandNotAllowedError(
      command.trim(),
      list,
      `"${program}" was not found on the PATH.`,
    );
  }

  // A .cmd / .bat is not an executable: Node refuses to spawn one without a
  // shell (EINVAL since Node 20 — measured here on Node 26). It is a script
  // cmd.exe interprets, and `npx` on Windows IS `npx.cmd`, so refusing it
  // outright would refuse the second most useful entry there is.
  //
  // So it runs through `cmd.exe /d /s /c`, with the command line built HERE
  // out of tokens already read and already allowed — never out of the agent's
  // string. Each argument is wrapped in double quotes, and one containing a
  // double quote or a caret is refused rather than escaped: escaping is the
  // cmd.exe imitation this whole redesign exists to stop doing.
  //
  // The line is wrapped in one more pair of quotes and passed verbatim, which
  // is the form `/s` documents and the only one measured to work: without the
  // outer pair cmd strips the inner ones, and without `verbatim` Node escapes
  // them as \" which cmd does not read.
  if (isWindows() && /\.(cmd|bat)$/i.test(resolved)) {
    for (const arg of args) {
      if (BREAKS_A_BATCH_LINE.test(arg)) {
        throw new CommandNotAllowedError(
          command.trim(),
          list,
          `"${program}" is a script that must run through cmd.exe, and an argument containing ` +
            'a double quote or a caret cannot be passed to it safely. Remove it.',
        );
      }
    }
    const line = [resolved, ...args].map((part) => `"${part}"`).join(' ');
    const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe';
    return {
      file: comspec,
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { file: resolved, args };
}
