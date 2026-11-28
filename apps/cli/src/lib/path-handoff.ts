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
//     line, and reads the paths in its configuration files, in the system's
//     ANSI code page (1252 on a western install). A `log_directory` written in
//     UTF-8 became "home A Ã©" and the postmaster exited; a data directory with
//     "Ω" became "home O" (Windows' best-fit mapping) and initdb created the
//     cluster in that OTHER folder, silently. See `postgres-code-page.ts`.
//   · cmd.exe reads a batch script in the console's code page (437 or 850), so
//     a script written in UTF-8 named a folder that does not exist. See
//     `batchScriptBytes` below.
//
// The rule this module holds: every path Nodal hands to another program goes
// through ONE question — "in which code page does this reader decode, and can
// that code page hold this path?" — and the answer is either the exact bytes
// the reader decodes back to the same path, or an error naming the program, the
// path, the character and what the person can do (invariant #4). Never a path
// moved somewhere else, never a short (8.3) name, never a best-fit spelling:
// the encoder below only knows the characters a code page really holds.
//
// A Node child (the runner, the web server, the CLI started by the dashboard)
// is not a reader in this sense: the OS hands it the command line and the
// environment in UTF-16 (Windows) or as the bytes Node wrote (POSIX), and Node
// decodes them back to the same string. `path-handoff.test.ts` proves it on a
// real child; there is no encoding step there for this module to own.

/** The code page of UTF-8, as Windows numbers it. */
export const UTF8_CODE_PAGE = 65001;

/** A program Nodal hands paths to. */
export interface PathReader {
  /** The program, as a person would name it in an error. */
  readonly program: string;
  /** The code page it decodes paths with. 65001 is UTF-8. */
  readonly codePage: number;
  /** What the person can do when a path does not fit. Said in every refusal. */
  readonly remedy?: string;
  /**
   * Spellings this reader REWRITES instead of reading them as they are, with
   * the reason: a path holding one would reach it as another path.
   */
  readonly rewrites?: { readonly pattern: RegExp; readonly reason: string };
}

/** A path the reader would not get back exactly. Carries the facts a person needs. */
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

// ── The code pages ───────────────────────────────────────────────────────────
//
// The ANSI code pages Windows ships, by number, and the WHATWG name under which
// Node's TextDecoder knows the same table. A double-byte page also says the
// range of its lead bytes (Big5 is held to the range code page 950 defines:
// WHATWG's Big5 adds Hong Kong characters Windows' 950 does not have).

const CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
};

const LEAD_BYTES: Readonly<Record<string, readonly [number, number]>> = {
  shift_jis: [0x81, 0xfc],
  gbk: [0x81, 0xfe],
  'euc-kr': [0x81, 0xfe],
  big5: [0xa1, 0xf9],
};

const encoders = new Map<string, ReadonlyMap<string, Buffer>>();

/**
 * Every character `label` holds, with its bytes. Built from the DECODER, so it
 * holds exactly the characters the code page decodes to — which is what makes
 * a best-fit spelling impossible: "Ω" is in no single-byte western table, so
 * it is refused, never turned into "O". The first byte sequence wins when a
 * character has two.
 */
function encoderFor(label: string): ReadonlyMap<string, Buffer> {
  const known = encoders.get(label);
  if (known) return known;
  const table = new Map<string, Buffer>();
  const decoder = new TextDecoder(label, { fatal: true });
  const add = (bytes: number[]): void => {
    let text: string;
    try {
      text = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    if ([...text].length === 1 && !table.has(text)) table.set(text, Buffer.from(bytes));
  };
  for (let b = 0; b < 0x100; b += 1) add([b]);
  const leads = LEAD_BYTES[label];
  if (leads) {
    for (let lead = leads[0]; lead <= leads[1]; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) add([lead, trail]);
    }
  }
  encoders.set(label, table);
  return table;
}

/** The name of a code page in an error: "code page 1252". */
function codePageName(codePage: number): string {
  return codePage === UTF8_CODE_PAGE ? 'UTF-8 (code page 65001)' : `code page ${codePage}`;
}

type Encoded = { bytes: Buffer } | { refused: string };

/** The bytes of `text` in `codePage`, or why that page cannot hold it. */
function encodeIn(codePage: number, text: string): Encoded {
  if (LONE_SURROGATE.test(text)) {
    // Windows allows it in a file name; no encoding a program reads carries it
    // (UTF-8 would turn it into U+FFFD, another name).
    return {
      refused:
        'it holds a character that no text encoding can carry (an unpaired UTF-16 surrogate)',
    };
  }
  if (codePage === UTF8_CODE_PAGE) return { bytes: Buffer.from(text, 'utf8') };
  const label = CODE_PAGE_LABELS[codePage];
  if (label === undefined) {
    // A code page Nodal has no table for: ASCII is the one alphabet every ANSI
    // code page shares, so that much is still exact.
    const first = NON_ASCII.exec(text)?.[0];
    if (first === undefined) return { bytes: Buffer.from(text, 'ascii') };
    return {
      refused: `it holds "${first}", and Nodal cannot encode for ${codePageName(codePage)}, so only ASCII is exact`,
    };
  }
  const table = encoderFor(label);
  const parts: Buffer[] = [];
  for (const ch of text) {
    const bytes = table.get(ch);
    if (bytes === undefined) {
      return { refused: `it holds "${ch}", which ${codePageName(codePage)} cannot carry` };
    }
    parts.push(bytes);
  }
  return { bytes: Buffer.concat(parts) };
}

/**
 * The exact bytes `reader` decodes back to `path`, or a `PathNotReadableError`
 * with the path, the character, the code page and the reader's remedy.
 */
export function encodePathFor(reader: PathReader, path: string): Buffer {
  const encoded = encodeIn(reader.codePage, path);
  let reason = 'refused' in encoded ? encoded.refused : null;
  if (reason === null && reader.rewrites && reader.rewrites.pattern.test(path)) {
    const found = reader.rewrites.pattern.exec(path)?.[0] ?? '';
    reason = `it holds "${found}", which ${reader.rewrites.reason}`;
  }
  if (reason !== null) {
    throw new PathNotReadableError(
      reader.program,
      path,
      reader.remedy ? `${reason}. ${reader.remedy}` : reason,
    );
  }
  return (encoded as { bytes: Buffer }).bytes;
}

/** Refuse, loudly and before anything is started or written, any path the reader would not get back exactly. */
export function checkPathsFor(reader: PathReader, paths: readonly string[]): void {
  for (const path of paths) encodePathFor(reader, path);
}

/**
 * The other direction: text a reader WROTE (PostgreSQL's `postmaster.pid`
 * names its data directory in the code page it reads paths in), decoded the
 * way it was written. A code page Nodal has no table for decodes its ASCII
 * exactly and nothing else, which is all `encodeIn` would ever have given it.
 */
export function decodeFromReader(reader: PathReader, bytes: Uint8Array): string {
  if (reader.codePage === UTF8_CODE_PAGE) return Buffer.from(bytes).toString('utf8');
  const label = CODE_PAGE_LABELS[reader.codePage];
  return label === undefined
    ? Buffer.from(bytes).toString('latin1')
    : new TextDecoder(label).decode(bytes);
}

/** The bytes of `text` for `reader`, after checking every path it carries. */
export function encodeForReader(
  reader: PathReader,
  text: string,
  paths: readonly string[],
): Buffer {
  checkPathsFor(reader, paths);
  const encoded = encodeIn(reader.codePage, text);
  if ('refused' in encoded) {
    throw new Error(`Text for ${reader.program} cannot be encoded: ${encoded.refused}`);
  }
  return encoded.bytes;
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
  codePage: UTF8_CODE_PAGE,
};

/**
 * The line registered under Run: Windows expands it (REG_EXPAND_SZ), then
 * cmd.exe expands its `/c` command, and neither has an escape for `%NAME%`.
 * Every other character is carried as it is (`autostart-script-runs.test.ts`).
 */
export const WINDOWS_RUN_LINE_READER: PathReader = {
  program: 'the Windows startup entry (a Run value started by cmd.exe)',
  codePage: UTF8_CODE_PAGE,
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
