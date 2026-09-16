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
// is refused outright rather than guessed at: command substitution AND
// variable expansion (HIDES_A_COMMAND / EXPANDS_LATER below).
//
// The list is DATA on the agent row (`agents.command_allowlist`), never a
// hardcoded per-agent branch — invariant #1.

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
 */
const EXPANDS_LATER = /\$\{|\$[A-Za-z_]|%[^%\s]*%/;

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

const WINDOWS = process.platform === 'win32';

function normalizeProgram(token: string): string {
  if (!WINDOWS) return token;
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

    if (c === '"' || c === "'") {
      quote = c;
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
