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

/**
 * Separators that start a NEW command in both cmd.exe and /bin/sh. Each side
 * of one is checked on its own: `node -v && rm -rf /` must be refused on its
 * second half, not allowed on its first.
 */
const SEGMENT_SEPARATORS = /&&|\|\||[;&|\n\r]/;

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

  const entries = allowlist.map((entry) => tokenize(entry)).filter((tokens) => tokens.length > 0);

  for (const segment of command.split(SEGMENT_SEPARATORS)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue; // empty side of a separator — nothing runs
    const allowed = entries.some((entry) => entry.every((token, i) => tokens[i] === token));
    if (!allowed) {
      throw new CommandNotAllowedError(segment.trim(), allowlist);
    }
  }
}

function tokenize(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}
