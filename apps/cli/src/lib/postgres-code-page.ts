// postgres-code-page.ts — in which encoding the embedded PostgreSQL reads paths.
//
// ## What was measured (Windows 11, code page 1252, 2026-11-28, #1231)
//
// PostgreSQL's Windows build is a non-Unicode program: its `main` receives the
// command line converted to the process's ANSI code page, and the bytes of a
// path read from `postgresql.conf` / `postgresql.auto.conf` are handed as they
// are to the ANSI file APIs. With a home "home A é":
//
//   · `log_directory` written in UTF-8 (C3 A9) is opened as "home A Ã©": the
//     postmaster exits with `FATAL: could not open log file`. Written in 1252
//     (E9) it starts. That is the table of #1231: the log path failed only when
//     it was ALSO the data directory's parent, because the collector creates
//     the last segment only (`MakePGDirectory`), so a mangled parent that did
//     not exist is a missing directory, while a mangled leaf is simply created.
//   · With "Ω" (not in 1252), initdb created the cluster in "home O" — Windows'
//     best-fit mapping — and reported success. With "😀" it failed on "home ??".
//   · A relative path does not help: the server makes its data directory
//     absolute with the ANSI `getcwd`, and gets the same "?".
//
// So no choice of bytes in a file makes PostgreSQL take every path. What does:
// the process's code page. Windows 10 1903 and later honour
// `<activeCodePage>UTF-8</activeCodePage>` in an application manifest
// (https://learn.microsoft.com/windows/apps/design/globalizing/use-utf8-code-page),
// and an exe with no EMBEDDED manifest — the case of every binary of
// `@embedded-postgres/windows-x64` — reads a side-by-side `<name>.exe.manifest`.
// With one beside initdb.exe, postgres.exe and pg_ctl.exe, the same cluster in
// "home 😀 Ω é" initialises, starts and writes its log there (measured).
//
// Windows caches an exe's activation context by path AND time stamp: a manifest
// added after the exe has run once is ignored until the exe's time stamp
// changes (measured: the echo stayed "probe O ??" with the manifest present,
// and became exact once the exe was touched). Hence the touch below, and hence
// the probe: what decides the reader is what the programs ACTUALLY receive,
// never the presence of a file.
//
// When the manifest cannot be written (an install folder this user cannot write
// to) or is not honoured (a Windows older than 1903), the reader is ASCII-only
// and says why: an ASCII home still works, any other is refused by name before
// a single file is created (`path-handoff.ts`). Never a best-fit folder.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PathReader } from './path-handoff.ts';

/** The three programs Nodal starts with a path, in the order they first run. */
export const POSTGRES_PROGRAMS = ['initdb', 'postgres', 'pg_ctl'] as const;
export type PostgresProgram = (typeof POSTGRES_PROGRAMS)[number];
export type PostgresBinaryPaths = Readonly<Record<PostgresProgram, string>>;

export const UTF8_CODE_PAGE_MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <!-- Written by nodal-agents (apps/cli/src/lib/postgres-code-page.ts): this
       program reads paths in UTF-8, so a home folder with any name works. -->
  <application>
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
`;

/**
 * A string with a letter from Latin-1, one from outside every single-byte code
 * page, and one outside the Basic Multilingual Plane: a program that echoes it
 * back exactly reads UTF-8.
 */
export const PROBE_TEXT = 'é Ω 😀';

/** The arguments under which each program writes back the data directory it was given. */
function echoArgs(program: PostgresProgram, dir: string): string[] {
  switch (program) {
    case 'initdb':
      return ['--show', '-D', dir]; // prints PGDATA=<dir> and exits
    case 'postgres':
      return ['-C', 'port', '-D', dir]; // "could not access directory "<dir>""
    case 'pg_ctl':
      return ['status', '-D', dir]; // "directory "<dir>" does not exist"
  }
}

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { encoding: 'buffer', windowsHide: true, timeout: 20_000 },
      (_err, stdout, stderr) => {
        resolve(Buffer.concat([stdout, stderr]).toString('utf8'));
      },
    );
  });
}

/**
 * Does `binary` receive `PROBE_TEXT` exactly on its command line? The path
 * given does not exist and nothing is created: each program only names it.
 */
export async function receivesUnicodeExactly(
  program: PostgresProgram,
  binary: string,
): Promise<boolean> {
  const dir = join(
    tmpdir(),
    `nodal-code-page-probe ${PROBE_TEXT} ${randomBytes(4).toString('hex')}`,
  );
  const out = await run(binary, echoArgs(program, dir));
  // PostgreSQL prints paths with forward slashes.
  return out.split('\\').join('/').includes(dir.split('\\').join('/'));
}

/**
 * Put the UTF-8 manifest beside `binary`, and make sure Windows reads it.
 * Returns null on success, or why it could not.
 *
 * Two facts on disk, checked on every call rather than remembered: the
 * manifest holds our text (rewritten when it does not), and the exe is NEWER
 * than its manifest. The second is what refreshes the activation context
 * Windows cached without the manifest; it is a state, not a step taken right
 * after a write, because a manifest put there without that step (a process
 * killed between the two, another tool, an earlier run) would otherwise leave
 * the cache stale for good — which is how the mutation of this line was found.
 */
export function ensureUtf8Manifest(binary: string): string | null {
  const manifest = `${binary}.manifest`;
  try {
    if (!existsSync(manifest) || readFileSync(manifest, 'utf8') !== UTF8_CODE_PAGE_MANIFEST) {
      const tmp = `${manifest}.nodalai.tmp`;
      writeFileSync(tmp, UTF8_CODE_PAGE_MANIFEST, 'utf8');
      renameSync(tmp, manifest);
    }
    const manifestTime = statSync(manifest).mtimeMs;
    if (statSync(binary).mtimeMs <= manifestTime) {
      const after = new Date(Math.max(Date.now(), manifestTime + 1000));
      utimesSync(binary, after, after);
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `the UTF-8 code page manifest could not be written beside ${basename(binary)} (${message})`;
  }
}

/** What `resolvePostgresPathReader` needs from the machine: injectable for a test. */
export interface CodePageEffects {
  platform: NodeJS.Platform;
  ensureManifest: (binary: string) => string | null;
  receivesUnicode: (program: PostgresProgram, binary: string) => Promise<boolean>;
}

const realEffects: CodePageEffects = {
  platform: process.platform,
  ensureManifest: ensureUtf8Manifest,
  receivesUnicode: receivesUnicodeExactly,
};

/**
 * The reader the embedded PostgreSQL programs are, on this machine.
 *
 * Outside Windows a path is the bytes Node wrote — UTF-8 — and PostgreSQL hands
 * them to the file system unchanged. On Windows: the manifest is put in place,
 * then EVERY program is asked to echo the probe; one that does not makes the
 * reader ASCII-only, with the reason.
 */
export async function resolvePostgresPathReader(
  binaries: PostgresBinaryPaths,
  fx: CodePageEffects = realEffects,
): Promise<PathReader> {
  const program = 'PostgreSQL';
  if (fx.platform !== 'win32') return { program, encoding: 'utf-8' };
  for (const name of POSTGRES_PROGRAMS) {
    const failure = fx.ensureManifest(binaries[name]);
    if (failure !== null) return { program, encoding: 'ascii', why: failure };
  }
  for (const name of POSTGRES_PROGRAMS) {
    if (!(await fx.receivesUnicode(name, binaries[name]))) {
      return {
        program,
        encoding: 'ascii',
        why:
          `${name}.exe still reads paths in this machine's ANSI code page although its ` +
          'UTF-8 manifest is in place (it needs Windows 10 version 1903 or later)',
      };
    }
  }
  return { program, encoding: 'utf-8' };
}
