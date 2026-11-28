// path-handoff.ts — a path Nodal hands to ANOTHER program.
//
// Nodal's home can be any folder the operating system allows: a profile named
// "Zoë", "Ωmega", "李", "😀". Node itself never has a problem with such a path —
// it talks to the file system in UTF-16 on Windows and in UTF-8 bytes elsewhere.
// The programs Nodal starts do not all do the same. Until 2026-11-28 the
// embedded database and the start-at-login script each read the home in an
// encoding nobody had chosen, and each failed on a home outside ASCII (#1231):
//
//   · PostgreSQL on Windows is a non-Unicode program. It receives its command
//     line, and reads the paths in its configuration files, in the process's
//     ANSI code page (1252 on a western install). A `log_directory` written in
//     UTF-8 became "home A Ã©" and the postmaster exited; a data directory with
//     "Ω" became "home O" (Windows' best-fit mapping) and initdb created the
//     cluster in that OTHER folder, silently. See `postgres-code-page.ts`.
//   · cmd.exe reads a batch script in the console's code page (437 or 850), so
//     a script written in UTF-8 named a folder that does not exist. See
//     `batchScriptBytes` below.
//
// The rule this module holds: every path Nodal hands to another program goes
// through ONE question — "what does this reader decode, and can it hold this
// path?" — and the answer is either the exact bytes the reader will decode back
// to the same path, or an error naming the program, the path and the reason
// (invariant #4). Never a path moved somewhere else, never a short (8.3) name,
// never a best-fit spelling.
//
// A Node child (the runner, the web server, the CLI started by the dashboard)
// is not a reader in this sense: the OS hands it the command line and the
// environment in UTF-16 (Windows) or as the bytes Node wrote (POSIX), and Node
// decodes them back to the same string. `path-handoff.test.ts` proves it on a
// real child; there is no encoding step there for this module to own.

/** What a reader decodes the bytes it is given with. */
export type ReaderEncoding =
  /** Any well-formed Unicode text survives. */
  | 'utf-8'
  /**
   * Only ASCII survives: a reader whose code page Nodal could not set and does
   * not know. ASCII is the one alphabet every code page shares.
   */
  | 'ascii';

/** A program Nodal hands paths to. */
export interface PathReader {
  /** The program, as a person would name it in an error ("PostgreSQL (initdb.exe)"). */
  readonly program: string;
  readonly encoding: ReaderEncoding;
  /** Why the reader is narrower than UTF-8, when it is. Said in every refusal. */
  readonly why?: string;
  /**
   * Spellings this reader REWRITES instead of reading them as they are, with
   * the reason: a path holding one would reach it as another path.
   */
  readonly rewrites?: { readonly pattern: RegExp; readonly reason: string };
}

/** A path the reader would not get back exactly. Carries the three facts a person needs. */
export class PathNotReadableError extends Error {
  readonly code = 'PATH_NOT_READABLE_BY_PROGRAM';
  constructor(
    readonly program: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${program} cannot be given the path "${path}": ${reason}`);
    this.name = 'PathNotReadableError';
  }
}

const NON_ASCII = /[^\x00-\x7f]/u;
/** A UTF-16 surrogate with no partner (the library target here has no `isWellFormed`). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why `reader` would not decode `path` back to itself, or null when it would.
 *
 * Exported for the start-at-login status, which asks the same question of a
 * script already on disk.
 */
export function unreadableReason(reader: PathReader, path: string): string | null {
  if (LONE_SURROGATE.test(path)) {
    // A lone surrogate: Windows allows it in a file name, no encoding a program
    // reads can carry it (UTF-8 would turn it into U+FFFD, another name).
    return 'it holds a character that no text encoding can carry (an unpaired UTF-16 surrogate)';
  }
  if (reader.encoding === 'ascii' && NON_ASCII.test(path)) {
    const first = NON_ASCII.exec(path)?.[0] ?? '';
    return (
      `this program only reads ASCII paths here, and the path holds "${first}"` +
      (reader.why ? ` (${reader.why})` : '')
    );
  }
  if (reader.rewrites && reader.rewrites.pattern.test(path)) {
    const found = reader.rewrites.pattern.exec(path)?.[0] ?? '';
    return `the path holds "${found}", which ${reader.rewrites.reason}`;
  }
  return null;
}

/** Refuse, loudly, any path the reader would not get back exactly. */
export function checkPathsFor(reader: PathReader, paths: readonly string[]): void {
  for (const path of paths) {
    const reason = unreadableReason(reader, path);
    if (reason !== null) throw new PathNotReadableError(reader.program, path, reason);
  }
}

/**
 * The bytes of `text` for `reader`, after checking every path it carries.
 *
 * Both encodings are written as UTF-8 bytes: for an ASCII reader the check
 * above has already guaranteed every path is ASCII, and ASCII is the same
 * bytes in both.
 */
export function encodeForReader(
  reader: PathReader,
  text: string,
  paths: readonly string[],
): Buffer {
  checkPathsFor(reader, paths);
  return Buffer.from(text, 'utf8');
}

// ── cmd.exe and batch scripts ────────────────────────────────────────────────
//
// cmd.exe decodes a batch file LINE BY LINE in the console's current code page,
// and `chcp` changes that code page for the lines that follow (measured on
// Windows 11, 2026-11-28: the same script, without the line, names
// "home ├⌐ ╬⌐ ≡ƒÿÇ" in code page 437; with it, the exact folder). So a script
// whose first lines are ASCII and which switches to 65001 (UTF-8) before any
// path is read the same whatever the console's code page was: the lines before
// the switch are ASCII, which every code page reads alike, and the lines after
// are UTF-8, which is what Node writes.

/** cmd.exe, once the script's own first lines have switched it to UTF-8. */
export const BATCH_SCRIPT_READER: PathReader = {
  program: 'the Windows command interpreter (cmd.exe)',
  encoding: 'utf-8',
};

/**
 * The line registered under Run: Windows expands it (REG_EXPAND_SZ), then
 * cmd.exe expands its `/c` command, and neither has an escape for `%NAME%`.
 * Every other character is carried as it is (`autostart-script-runs.test.ts`).
 */
export const WINDOWS_RUN_LINE_READER: PathReader = {
  program: 'the Windows startup entry (a Run value started by cmd.exe)',
  encoding: 'utf-8',
  rewrites: {
    pattern: /%[^%]+%/,
    reason: 'Windows and cmd.exe replace with the value of an environment variable of that name',
  },
};

/** The lines every batch script Nodal writes starts with, in this order. ASCII. */
export const BATCH_PRELUDE = ['@echo off', 'chcp 65001 >nul'] as const;

/**
 * A whole batch script: the prelude, then `lines`, CRLF-terminated, as the
 * bytes cmd.exe will read. `paths` are the paths the lines carry.
 */
export function batchScriptBytes(lines: readonly string[], paths: readonly string[]): Buffer {
  const text = [...BATCH_PRELUDE, ...lines].map((l) => `${l}\r\n`).join('');
  return encodeForReader(BATCH_SCRIPT_READER, text, paths);
}

/**
 * Would cmd.exe read `bytes` as the text they were written as, whatever the
 * console's code page? True when every byte before the switch to UTF-8 is
 * ASCII and everything after it is well-formed UTF-8. A script with no switch
 * qualifies only when it is ASCII throughout — which is every script an earlier
 * version wrote for an ASCII home, and none it wrote for any other.
 */
export function batchScriptReadable(bytes: Uint8Array): boolean {
  const asLatin1 = Buffer.from(bytes).toString('latin1');
  const switchAt = asLatin1.search(/^chcp 65001\b/im);
  const head = switchAt < 0 ? asLatin1 : asLatin1.slice(0, switchAt);
  if (NON_ASCII.test(head)) return false;
  if (switchAt < 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes).subarray(switchAt));
    return true;
  } catch {
    return false;
  }
}
