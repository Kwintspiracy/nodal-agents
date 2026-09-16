// builtin/command-allowlist.ts — the per-agent command allowlist.
//
// WHY THIS EXISTS. `run_command` had exactly two controls: the per-agent
// `command-execution` skill (which decides IF the agent gets a shell) and the
// approval gate (which asks a human before each command). Neither of them can
// say "this agent may run `node` and `npx vitest`, and nothing else" — so an
// agent whose job needs to EXECUTE a snippet to check a claim had to be given,
// unattended, a shell that can do anything. That is the gap this closes.
//
// WHAT IT IS NOT. This is not a sandbox and it does not pretend to be one.
// `node` can open a socket, read outside the workspace, and write files; the
// allowlist restricts WHICH PROGRAM starts, not what that program may then do.
// It is the third control alongside the skill and the approval gate, and it is
// the one that makes an unattended (auto-approved) shell a defensible choice
// for a narrow job.
//
// WHAT THE SCAN READS, AND WHAT THE SHELL READS. `run-command.ts` hands the
// string to `shell-engine.ts`, which spawns it with `shell: true` — that is
// `cmd.exe /d /s /c "<command>"` on Windows and `/bin/sh -c "<command>"`
// elsewhere. The scan therefore runs on the string BEFORE the shell rewrites
// it. Every construct whose rewrite could produce a program the scan never saw
// is refused outright rather than guessed at, on both platforms: command
// substitution and variable expansion (HIDES_A_COMMAND / EXPANDS_LATER below).
// On Windows two more, because cmd.exe reads them unlike any other shell: the
// SINGLE QUOTE, which it does not treat as a string at all, and the CARET,
// which is its escape character. Those five are the LIMITS SAID OUT LOUD: a
// command using one is refused while a list is set, and an agent restricted to
// node or vitest never needs any of them.
//
// The rule behind all five is the same, and it is the lesson of five review
// passes: do not imitate the shell. Every finer imitation left one more notch
// (`2>&1`, then quoted separators, then `^>&`), and the only end to that is to
// refuse the construct.
//
// WHAT IT GOVERNS, AND WHAT IT DOES NOT. `run_command`, and nothing else.
// `run_skill_script`, `code_task` (the Claude Code / Codex CLIs) and the
// `verify_commands` of `declare_verification` all start processes WITHOUT
// consulting this list — verified by grepping `commandAllowlist` across the
// repo. An owner who sets `['node']` has narrowed one door, not confined the
// agent. Saying so here because a control that reads as broader than it is is
// worse than no control: it buys a decision (turning auto-approve on) with a
// guarantee it does not provide.
//
// A SHELL ON THE LIST IS A LIST THAT MEANS NOTHING. `cmd` reads as "this agent
// may run cmd" and grants `cmd /c <anything>`, because this check has already
// passed by the time the shell picks its child. Same for `powershell -c`,
// `sh -c`, `bash -lc`, `wsl <x>`. The set is `SHELL_PROGRAMS`
// (`@nodal-agents/shared`) and the settings action refuses such an entry when
// the owner SAVES it — the honest moment to say the product cannot honour that
// intention, rather than three weeks later inside a job. Nothing re-checks it
// here: this module compares a program name, which is what it is good at.
//
// The list is DATA on the agent row (`agents.command_allowlist`), never a
// hardcoded per-agent branch — invariant #1. It is read ONCE per job, when the
// runner loads the agent row (`apps/runner/src/job/execute.ts`), and the same
// value is reused when the job resumes after an approval: tightening a list
// mid-job does not apply to the job already running.

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
 * Anything that would run a command the segment scan cannot see: `$(...)` and
 * backtick substitution. Refused outright rather than parsed — a half-parser
 * that gets this wrong is worse than no check, because it reads as one.
 */
const HIDES_A_COMMAND = /\$\(|`/;

/**
 * Variable expansion, in either shell: `%NAME%` (cmd.exe), `$NAME` and
 * `${NAME}` (/bin/sh).
 *
 * Refused for the same reason as `$(...)`, and worth spelling out because it
 * is NOT obvious: the scan sees the string the agent wrote, the shell runs the
 * string AFTER expansion. With `EVIL=&& calc` in the environment,
 * `node s.js %EVIL%` scans as one allowed `node` segment and starts two
 * programs. The value is not ours to read — the child environment is built
 * elsewhere (`child-env.ts`) and inherits the host's — so the only honest
 * answer is to refuse the construct.
 *
 * Both syntaxes are refused on BOTH platforms. A rule that depends on which
 * machine the agent happens to run on is a rule nobody can reason about, and
 * the inert one costs a listed agent nothing: it writes the value literally.
 *
 * KNOWN FALSE REFUSAL, accepted: a literal `%` pair inside a filename or an
 * argument (`node build.js report%20final.txt`) reads as an expansion and is
 * refused. Telling the two apart means knowing what cmd.exe will find in the
 * environment, which is the thing this check cannot do — so the error stays on
 * the conservative side, where the fix is to rename the file.
 */
const EXPANDS_LATER = /\$\{|\$[A-Za-z_]|%[^%\s]*%/;

/**
 * Does `command` carry a single quote that cmd.exe would NOT read as a string?
 *
 * `cmd.exe` has no single-quoted string. `node -e 'x & calc'` therefore scans
 * as one quoted argument and RUNS TWO PROGRAMS — the `&` inside is a separator
 * to the shell and was one to nobody else. Same inversion for `;`, `|`, `&&`
 * and a newline.
 *
 * Refused rather than parsed, in the direction that protects. But only OUTSIDE
 * a double-quoted region: inside `"..."` cmd.exe is already not reading
 * separators, and `node -e "console.log('x')"` is both safe and the shape
 * everybody writes. A blanket refusal would have broken it — measured, two
 * tool-level tests went red on the first version of this guard. Refusing a
 * working command is how a guard gets widened until it means nothing.
 */
function hasBareSingleQuote(command: string): boolean {
  let inDoubleQuotes = false;
  for (const c of command) {
    if (c === '"') inDoubleQuotes = !inDoubleQuotes;
    else if (c === "'" && !inDoubleQuotes) return true;
  }
  return false;
}

/** One command between two separators, with its tokens already extracted. */
interface Segment {
  readonly tokens: readonly string[];
  readonly raw: string;
}

/** A quote opened and never closed — the shell would not run this either. */
const UNTERMINATED_QUOTE = Symbol('unterminated_quote');

/**
 * Refuse `command` unless every one of its segments starts with an entry of
 * `allowlist`.
 *
 * `null` / `undefined` = no allowlist configured: unchanged, unrestricted
 * behaviour. An EMPTY ARRAY is a decision, not an absence — it refuses
 * everything. (Reading `[]` as "unset" would silently widen the strictest
 * configuration someone can express.)
 *
 * An entry may be one word (`node`) or several (`npx vitest`); it matches when
 * the segment's leading tokens equal the entry's tokens, whole-token — `node`
 * does not admit `nodemon`.
 */
export function assertCommandAllowed(
  command: string,
  allowlist: readonly string[] | null | undefined,
): void {
  if (allowlist === null || allowlist === undefined) return;

  if (HIDES_A_COMMAND.test(command)) {
    throw new CommandNotAllowedError(
      command.trim(),
      allowlist,
      'Command substitution is refused while an allowlist is set: the check cannot see what it would run.',
    );
  }

  if (EXPANDS_LATER.test(command)) {
    throw new CommandNotAllowedError(
      command.trim(),
      allowlist,
      'Variable expansion (%NAME%, $NAME, ${NAME}) is refused while an allowlist is set: the check ' +
        'runs before the shell expands it, so it cannot see which program would start. ' +
        'Write the value literally.',
    );
  }

  if (isWindows() && hasBareSingleQuote(command)) {
    throw new CommandNotAllowedError(
      command.trim(),
      allowlist,
      'A single quote outside double quotes is refused while an allowlist is set on Windows: ' +
        "cmd.exe does not read '...' as a string, so what looks like one quoted argument can be " +
        'several commands. Use double quotes.',
    );
  }

  // The caret is cmd.exe's escape character, and it changes what the NEXT
  // character means to the shell without changing what it looks like here.
  // `node x ^>& calc` scans as one segment — the `&` reads as a redirection
  // because a `>` sits before it — while cmd.exe takes `^>` as a literal `>`,
  // leaving the `&` a bare separator that starts `calc`.
  //
  // The whole CLASS is refused rather than that one shape. Teaching the
  // scanner about `^>` would leave `^&`, then `^|`, then a caret before a
  // quote: every pass of this review found one more notch in the imitation,
  // and the only end to that is to stop imitating. A reviewer running node or
  // vitest never needs a caret, so the cost is nil and the rule is one anybody
  // can hold in their head.
  if (isWindows() && command.includes('^')) {
    throw new CommandNotAllowedError(
      command.trim(),
      allowlist,
      'A caret is refused while an allowlist is set on Windows: it is cmd.exe’s escape ' +
        'character, so the check cannot see what it changes. Write the command without one.',
    );
  }

  const split = splitIntoSegments(command);
  if (split === UNTERMINATED_QUOTE) {
    throw new CommandNotAllowedError(
      command.trim(),
      allowlist,
      'Unterminated quote: the command cannot be read reliably, so it is refused.',
    );
  }

  const entries = allowlist
    .map((entry) => tokenizeEntry(entry))
    .filter((tokens) => tokens.length > 0);

  for (const segment of split) {
    if (segment.tokens.length === 0) continue; // empty side of a separator — nothing runs
    const allowed = entries.some((entry) => matches(entry, segment.tokens));
    if (!allowed) {
      throw new CommandNotAllowedError(segment.raw.trim(), allowlist);
    }
  }
}

/**
 * An entry matches when its tokens equal the segment's leading tokens.
 *
 * The FIRST token is the PROGRAM, and on Windows one program has several
 * spellings: PATH resolves `npx` to `npx.cmd`, the shell is case-insensitive,
 * and an agent writing `node.exe` means `node`. Comparing the program
 * case-insensitively and without a `.exe` / `.cmd` / `.bat` suffix THERE is
 * what the OS itself does; refusing those spellings is a false red nobody can
 * debug. Off Windows, where case and suffix are meaningful, the comparison
 * stays exact.
 *
 * A PATH is deliberately NOT reduced to its basename: `./node` and
 * `C:\tools\node.exe` stay refused against an entry `node`. An entry names a
 * program to be found on PATH, not a file — accepting any path that ends in
 * `node` would let the agent point the entry at a binary it wrote itself. The
 * comparison below gives that for free: `c:\tools\node` is not `node`.
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

/**
 * Which shell `shell-engine.ts` will actually spawn. Read at call time, not
 * captured at module load: a test must be able to prove BOTH shells' rules
 * from one machine, and the two differ in ways that decide whether a command
 * is one program or two.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

function normalizeProgram(token: string): string {
  if (!isWindows()) return token;
  return token.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * Split a command into the commands the shell would actually start, and
 * tokenize each one.
 *
 * Two things a plain `String.split(/&&|\|\||[;&|\n\r]/)` gets wrong, both of
 * them in the direction that breaks a working command — the failure nobody
 * reports as a security bug and everybody works around by widening the list
 * until it means nothing:
 *
 *  - `2>&1` (and any `N>&M` / `N<&M`) is a REDIRECTION, not a separator.
 *    Splitting on its `&` leaves a segment `1`, refused against every
 *    allowlist, so `node x.js > out.log 2>&1` could not be run at all.
 *  - a separator inside a quoted string is not a separator. `node -e "a;b"`
 *    passes ONE argument to node; splitting it invents a segment `b"`.
 *
 * Quotes are consumed the way both shells do: the content joins the token, the
 * quote characters do not. Backslash is NOT an escape here — on Windows it is
 * the path separator, and reading a path as an escape would corrupt every one
 * of them. A quote left open yields UNTERMINATED_QUOTE and the caller refuses,
 * in the direction that protects.
 */
function splitIntoSegments(command: string): Segment[] | typeof UNTERMINATED_QUOTE {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let segmentStart = 0;
  let quote: '"' | "'" | null = null;

  const endToken = (): void => {
    if (tokenStarted) {
      tokens.push(token);
      token = '';
      tokenStarted = false;
    }
  };
  const endSegment = (endIndex: number): void => {
    endToken();
    segments.push({ tokens, raw: command.slice(segmentStart, endIndex) });
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;

    if (quote !== null) {
      if (c === quote) quote = null;
      else {
        token += c;
        tokenStarted = true;
      }
      continue;
    }

    // `"` is a string in BOTH shells. `'` is one to /bin/sh and NOTHING to
    // cmd.exe, so on Windows it stays an ordinary character and any separator
    // inside it stays a separator. assertCommandAllowed refuses the construct
    // outright there; this keeps the scanner honest either way.
    if (c === '"' || (c === "'" && !isWindows())) {
      quote = c as '"' | "'";
      tokenStarted = true; // `node -e ""` passes an empty argument, not nothing
      continue;
    }

    // `N>&M` / `N<&M`: this `&` belongs to the redirection that precedes it.
    if (c === '&' && i > 0 && (command[i - 1] === '>' || command[i - 1] === '<')) {
      token += c;
      tokenStarted = true;
      continue;
    }

    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      endSegment(i);
      i++; // consume the second character of the pair
      segmentStart = i + 1;
      continue;
    }

    if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '\r') {
      endSegment(i);
      segmentStart = i + 1;
      continue;
    }

    if (c === ' ' || c === '\t') {
      endToken();
      continue;
    }

    token += c;
    tokenStarted = true;
  }

  if (quote !== null) return UNTERMINATED_QUOTE;
  endSegment(command.length);
  return segments;
}

/**
 * An allowlist entry is written by a human in the agent settings, not produced
 * by a shell: splitting on whitespace is the whole job.
 */
function tokenizeEntry(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

// ─── The program the SHELL resolves, not the word the agent typed ────────────
//
// `assertCommandAllowed` compares a TOKEN. `cmd.exe` resolves an unqualified
// executable from the CURRENT DIRECTORY before the PATH, and the current
// directory is the agent's own workspace — which the agent can write to with
// `file_write`. Drop a `node.cmd` there and `node x.js`, a command the list
// accepts, starts that script instead of the real node. Reproduced on Windows
// 11 with the env `buildChildEnv` actually produces: stdout was the planted
// script, not `v26.x`.
//
// Two answers, because one can be ignored by a host and the other cannot see
// everything:
//   - `shellLookupHardening` tells the shell not to look in the working
//     directory at all;
//   - `assertNoProgramShadowedByCwd` refuses the command when a file with the
//     program's name is sitting there. A `node.cmd` in a workspace is not an
//     accident, and refusing says so instead of quietly running the right
//     binary and leaving the planted one for the next call.

/**
 * Windows' actual out-of-the-box PATHEXT, used only when the host holds none.
 * Worth noting what a hand-written version of this list got wrong here, in the
 * dangerous direction: it carried `.ps1` (NOT in the default) and omitted
 * `.VBS .VBE .JS .JSE .WSF .WSH .MSC` — so a planted `node.js` or `node.vbs`
 * walked past the guard, which is exactly the case it exists to catch.
 */
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Extensions `cmd.exe` would append to an unqualified name: the HOST's PATHEXT
 * UNION the Windows default, plus `.ps1`. Never one or the other.
 *
 * The host's, because that is the PATHEXT the child gets — `child-env.ts`
 * passes it through untouched — and an admin who adds an extension must not
 * end up with a guard narrower than the shell it guards.
 *
 * The default as well, and not merely as a fallback for an unset variable,
 * because PATHEXT can be narrower than the default in a perfectly ordinary
 * process. Measured while writing this: a vitest worker on Windows 11 runs
 * with `.JS` missing from PATHEXT while `.JSE` is still there. Intersecting
 * with an environment nobody audits would silently stop refusing a planted
 * `node.js` — the exact file this guard exists for.
 *
 * `.ps1` is kept on top of both. It is not in the Windows default and
 * `cmd.exe` will not run it, but PowerShell will, and a `node.ps1` in an
 * agent's workspace is worth refusing on sight either way.
 *
 * Read at call time, not at module load, so a test can stub PATHEXT and a
 * long-lived runner picks up an environment that changed under it.
 */
function windowsExecutableExtensions(): string[] {
  const parse = (value: string): string[] =>
    value
      .split(';')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.startsWith('.') && entry.length > 1);

  const extensions = new Set(parse(WINDOWS_DEFAULT_PATHEXT));
  for (const entry of parse(process.env['PATHEXT'] ?? '')) extensions.add(entry);
  extensions.add('.ps1');
  return [...extensions];
}

/** A token carrying a path is not resolved from the cwd, and the list refuses it anyway. */
function isQualifiedPath(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.includes(':');
}

/**
 * Environment additions that stop the shell resolving a program from the
 * working directory. Applied ONLY when an allowlist is set — an unrestricted
 * agent keeps the behaviour it has always had.
 *
 * Windows: `NoDefaultCurrentDirectoryInExePath` is Microsoft's documented
 * switch for exactly this, and `cmd.exe` then skips the current directory for
 * unqualified executables. It is NOT in `child-env.ts`'s allowlist, so it must
 * be added as an explicit extra — which is also why the hole was live.
 *
 * Unix: `/bin/sh` looks in the working directory only when PATH says so, as an
 * empty entry or a literal `.`. Both are dropped.
 */
export function shellLookupHardening(
  sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  if (process.platform === 'win32') {
    return { NoDefaultCurrentDirectoryInExePath: '1' };
  }
  const path = sourceEnv['PATH'];
  if (path === undefined) return {};
  const cleaned = path
    .split(':')
    .filter((entry) => entry !== '' && entry !== '.')
    .join(':');
  return cleaned === path ? {} : { PATH: cleaned };
}

/**
 * Refuse `command` when a file named like one of its programs sits in `cwd`.
 *
 * Belt to `shellLookupHardening`'s braces: the environment switch can be
 * ignored (another shell, a host that filters the variable), this cannot. It
 * reads the directory ONCE and compares names — no `stat` per candidate.
 *
 * A `null` / `undefined` allowlist returns without reading anything: there is
 * no promise to keep, and refusing would change what an unrestricted agent can
 * do.
 *
 * An unreadable `cwd` is NOT a refusal. The command is about to fail to start
 * anyway, and turning an I/O error into a security verdict would fail loud for
 * the wrong reason.
 */
export async function assertNoProgramShadowedByCwd(
  command: string,
  allowlist: readonly string[] | null | undefined,
  cwd: string,
): Promise<void> {
  if (allowlist === null || allowlist === undefined) return;

  const split = splitIntoSegments(command);
  if (split === UNTERMINATED_QUOTE) return; // already refused by assertCommandAllowed

  const programs = split
    .map((segment) => ({ program: segment.tokens[0], raw: segment.raw }))
    .filter(
      (s): s is { program: string; raw: string } =>
        s.program !== undefined && !isQualifiedPath(s.program),
    );
  if (programs.length === 0) return;

  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(cwd);
  } catch {
    return;
  }
  const present = new Set(isWindows() ? names.map((n) => n.toLowerCase()) : names);

  for (const { program, raw } of programs) {
    const candidates = isWindows()
      ? [program, ...windowsExecutableExtensions().map((ext) => `${program}${ext}`)].map((c) =>
          c.toLowerCase(),
        )
      : [program];
    const planted = candidates.find((candidate) => present.has(candidate));
    if (planted !== undefined) {
      throw new CommandNotAllowedError(
        raw.trim(),
        allowlist,
        `A file named "${planted}" sits in the working directory, and the shell resolves a ` +
          `program from there before the PATH — so this command would not start the "${program}" ` +
          `the list names. Remove that file, or run the program by an explicit path.`,
      );
    }
  }
}
