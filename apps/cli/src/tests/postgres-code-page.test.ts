// postgres-code-page.test.ts — the code page the embedded PostgreSQL programs
// read paths in, and what Nodal writes for them in it (#1231).
//
// The rule on every system, with the code page injected: what is written in
// postgresql.auto.conf is the path's bytes in that page; a character the page
// does not hold is refused by name, never spelled another way ("Ω" is not "O");
// a UTF-8 page takes every character. Then, on Windows, the real reading of
// the system's code page — this runs on the Windows CI too.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANSI_CODE_PAGE_KEY,
  WINDOWS_CODE_PAGE_REMEDY,
  parseAnsiCodePage,
  postgresReaderFor,
  readWindowsAnsiCodePage,
  resolvePostgresPathReader,
} from '../lib/postgres-code-page.ts';
import { applyPostgresLoggingConfig } from '../lib/pg-logging.ts';
import { PathNotReadableError, decodeFromReader, encodePathFor } from '../lib/path-handoff.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nodal-codepage-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The bytes of `log_directory = '…'` as they are on disk. */
function logDirectoryLine(dataDir: string): Buffer {
  const bytes = readFileSync(join(dataDir, 'postgresql.auto.conf'));
  const start = bytes.indexOf(Buffer.from("log_directory = '"));
  const end = bytes.indexOf(0x0a, start);
  return bytes.subarray(start, end);
}

describe('the code page the PostgreSQL programs read paths in @cap:installer-et-demarrer/moteur', () => {
  it('outside Windows: UTF-8, without asking Windows anything', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const reader = resolvePostgresPathReader(platform, () => {
        throw new Error('no registry here');
      });
      expect(reader).toEqual({ program: 'PostgreSQL', codePage: 65001 });
    }
  });

  it('on Windows: the code page Windows keeps, with the way out named', () => {
    expect(resolvePostgresPathReader('win32', () => 932)).toEqual({
      program: 'PostgreSQL',
      codePage: 932,
      remedy: WINDOWS_CODE_PAGE_REMEDY,
    });
    // A system already set to UTF-8 needs no way out.
    expect(resolvePostgresPathReader('win32', () => 65001)).toEqual({
      program: 'PostgreSQL',
      codePage: 65001,
    });
  });

  it('reads the value `reg query` prints, and only that', () => {
    expect(
      parseAnsiCodePage(`\r\n${ANSI_CODE_PAGE_KEY}\r\n    ACP    REG_SZ    1252\r\n\r\n`),
    ).toBe(1252);
    expect(
      parseAnsiCodePage('ERROR: The system was unable to find the specified registry key'),
    ).toBe(null);
  });
});

describe('postgresql.auto.conf, in the reader’s code page @cap:installer-et-demarrer/moteur', () => {
  it('code page 1252: "é" is the one byte E9, as the server reads it', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), 'home A é', 'logs');
    applyPostgresLoggingConfig(dataDir, logDir, postgresReaderFor(1252));
    const line = logDirectoryLine(dataDir);
    expect(line.includes(Buffer.from([0x20, 0x41, 0x20, 0xe9, 0x2f]))).toBe(true); // " A é/"
    expect(line.includes(Buffer.from('é', 'utf8'))).toBe(false);
  });

  it('code page 932: the second byte of "表" is a backslash, and it is doubled so the server keeps it', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), '表');
    applyPostgresLoggingConfig(dataDir, logDir, postgresReaderFor(932));
    // 表 is 95 5C in code page 932; the configuration lexer would eat a lone 5C.
    expect(logDirectoryLine(dataDir).includes(Buffer.from([0x95, 0x5c, 0x5c]))).toBe(true);
  });

  it('a UTF-8 system code page takes every character, exactly', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), 'home Ω 李 😀 é');
    applyPostgresLoggingConfig(dataDir, logDir, postgresReaderFor(65001));
    expect(
      logDirectoryLine(dataDir).includes(Buffer.from('home Ω 李 😀 é'.replace(/\\/g, '/'), 'utf8')),
    ).toBe(true);
  });

  it('a character the page does not hold: refused by name, and the log folder is not created', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), 'home Ω', 'logs');
    expect(() => applyPostgresLoggingConfig(dataDir, logDir, postgresReaderFor(1252))).toThrow(
      PathNotReadableError,
    );
    expect(() => applyPostgresLoggingConfig(dataDir, logDir, postgresReaderFor(1252))).toThrow(
      /it holds "Ω", which code page 1252 cannot carry/,
    );
    expect(() => readFileSync(join(dataDir, 'postgresql.auto.conf'))).toThrow(/ENOENT/);
  });

  it('no best fit: "Ω", "ﬁ" or "①" are never written as "O", "fi" or "1"', () => {
    const reader = postgresReaderFor(1252);
    for (const ch of ['Ω', 'ﬁ', '①', 'ł', '😀']) {
      expect(() => encodePathFor(reader, `C:\\home ${ch}`)).toThrow(`it holds "${ch}"`);
    }
  });

  it('what the server writes back in its code page is read back as the same path', () => {
    for (const [codePage, path] of [
      [1252, 'C:/Users/Zoë/pg-data'],
      [932, 'C:/ユーザー/表/pg-data'],
      [1251, 'C:/Пользователи/pg-data'],
      [65001, 'C:/home 😀/pg-data'],
    ] as const) {
      const reader = postgresReaderFor(codePage);
      expect(decodeFromReader(reader, encodePathFor(reader, path))).toBe(path);
    }
  });
});

describe.skipIf(process.platform !== 'win32')(
  'this Windows machine’s code page @cap:installer-et-demarrer/moteur',
  () => {
    it('is read from where Windows keeps it, and is one Nodal encodes for', () => {
      const codePage = readWindowsAnsiCodePage();
      expect(Number.isInteger(codePage)).toBe(true);
      // ASCII is exact in every page; a page with a table also round-trips its own letters.
      const reader = postgresReaderFor(codePage);
      expect(decodeFromReader(reader, encodePathFor(reader, 'C:\\a b'))).toBe('C:\\a b');
    });
  },
);
