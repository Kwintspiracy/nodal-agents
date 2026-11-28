// postgres-code-page.ts — in which code page the embedded PostgreSQL reads paths.
//
// ## What was measured (Windows 11, code page 1252, 2026-11-28, #1231)
//
// PostgreSQL's Windows build is a non-Unicode program: its `main` receives the
// command line converted to the system's ANSI code page, and the bytes of a
// path read from `postgresql.conf` / `postgresql.auto.conf` are handed as they
// are to the ANSI file APIs. With a home "home A é":
//
//   · `log_directory` written in UTF-8 (C3 A9) is opened as "home A Ã©": the
//     postmaster exits with `FATAL: could not open log file`. Written in 1252
//     (E9) it starts. That is the table of #1231: the log path failed only when
//     it was ALSO under a mangled parent that does not exist, because the
//     collector creates the last segment only, so a mangled leaf is simply
//     created somewhere else.
//   · With "Ω" (not in 1252), initdb created the cluster in "home O" — Windows'
//     best-fit mapping of the command line — and reported success. With "😀"
//     it failed on "home ??".
//   · A relative path does not help: the server makes its data directory
//     absolute with the ANSI `getcwd`, and gets the same "?".
//
// So the reader is the system's ANSI code page, for the command line and for
// the configuration alike. Nodal writes each path in that code page and
// REFUSES, by name and before any program starts, a path the page cannot hold
// (`path-handoff.ts`): the "home O" cluster is what must never happen again.
//
// ## What this does not do, and what it would cost
//
// A path outside the system's code page is refused, not made to work. Making
// it work is possible — a side-by-side manifest giving the three programs the
// UTF-8 code page, measured to work for "home 😀 Ω é" — but it writes files
// beside third-party binaries in the installed package and changes their dates
// on every Windows install, for the few whose path the system page cannot hold.
// That form is kept, measured, on the branch `exp/non-ascii-home-utf8-manifest`.
// The refusal names the way out that is the person's to take: Nodal's home
// elsewhere (`NODALAI_HOME`), or Windows' own system-wide UTF-8 option.

import { execFileSync } from 'node:child_process';
import { NODALAI_HOME_ENV } from '@nodal-agents/shared/nodal-home';
import { UTF8_CODE_PAGE, type PathReader } from './path-handoff.ts';

/** The three programs Nodal starts with a path. */
export const POSTGRES_PROGRAMS = ['initdb', 'postgres', 'pg_ctl'] as const;
export type PostgresProgram = (typeof POSTGRES_PROGRAMS)[number];
export type PostgresBinaryPaths = Readonly<Record<PostgresProgram, string>>;

/** Where Windows keeps the system's ANSI code page (what `GetACP` answers). */
export const ANSI_CODE_PAGE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage';

/** The value `reg query <key> /v ACP` prints, as a number, or null when there is none. */
export function parseAnsiCodePage(regOutput: string): number | null {
  const match = /^\s*ACP\s+REG_SZ\s+(\d+)\s*$/m.exec(regOutput);
  return match ? Number(match[1]) : null;
}

/**
 * The system's ANSI code page, read where Windows keeps it. Synchronous, and
 * read once per process: the lockfile check that needs it is synchronous, and
 * the value only changes with a reboot. Fails loud when it cannot be read.
 */
export function readWindowsAnsiCodePage(): number {
  let out = '';
  let failure = '';
  try {
    out = execFileSync('reg', ['query', ANSI_CODE_PAGE_KEY, '/v', 'ACP'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const codePage = parseAnsiCodePage(out);
  if (codePage !== null) return codePage;
  throw new Error(
    `ANSI_CODE_PAGE_UNREADABLE: Windows did not say which code page PostgreSQL reads ` +
      `paths in (reg query ${ANSI_CODE_PAGE_KEY} /v ACP: ${failure || out.trim() || 'no answer'}).`,
  );
}

/**
 * What a person can do when their path does not fit the code page. The name
 * of the Windows option is the one Windows shows.
 */
export const WINDOWS_CODE_PAGE_REMEDY =
  `Put Nodal's home in a folder whose path that code page can carry (the ${NODALAI_HOME_ENV} ` +
  'setting), or, if you choose to, turn on the Windows option "Beta: Use Unicode UTF-8 for ' +
  'worldwide language support" (Region settings, Administrative, Change system locale), ' +
  'which changes this for every program on the machine.';

/** The PostgreSQL programs, as a reader decoding in `codePage`. */
export function postgresReaderFor(codePage: number): PathReader {
  return {
    program: 'PostgreSQL',
    codePage,
    ...(codePage === UTF8_CODE_PAGE ? {} : { remedy: WINDOWS_CODE_PAGE_REMEDY }),
  };
}

let machineReader: PathReader | null = null;

/**
 * The reader the embedded PostgreSQL programs are, on this machine. Outside
 * Windows a path is the bytes Node wrote — UTF-8 — and PostgreSQL hands them to
 * the file system unchanged. On Windows, the system's ANSI code page.
 */
export function resolvePostgresPathReader(
  platform: NodeJS.Platform = process.platform,
  readCodePage: () => number = readWindowsAnsiCodePage,
): PathReader {
  if (platform !== 'win32') return postgresReaderFor(UTF8_CODE_PAGE);
  return postgresReaderFor(readCodePage());
}

/** `resolvePostgresPathReader` for this process, read once. */
export function postgresPathReader(): PathReader {
  machineReader ??= resolvePostgresPathReader();
  return machineReader;
}
