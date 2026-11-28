// postgres-code-page.test.ts — the encoding the embedded PostgreSQL programs
// read paths in, decided by what they ACTUALLY receive (#1231).
//
// The rule (`resolvePostgresPathReader`) with the machine injected, on every
// system; then, on Windows, the real thing on the real binaries: the UTF-8
// manifest is beside each of them and each echoes back a path with "é Ω 😀"
// exactly. That case runs on the Windows CI, whose runner cannot start a
// cluster but can run these three programs.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POSTGRES_PROGRAMS,
  UTF8_CODE_PAGE_MANIFEST,
  ensureUtf8Manifest,
  receivesUnicodeExactly,
  resolvePostgresPathReader,
  type CodePageEffects,
  type PostgresBinaryPaths,
} from '../lib/postgres-code-page.ts';
import { postgresBinaryPaths } from '../lib/postgres.ts';

const FAKE_BINARIES: PostgresBinaryPaths = {
  initdb: 'X:\\pg\\bin\\initdb.exe',
  postgres: 'X:\\pg\\bin\\postgres.exe',
  pg_ctl: 'X:\\pg\\bin\\pg_ctl.exe',
};

function machine(over: Partial<CodePageEffects>): CodePageEffects {
  return {
    platform: 'win32',
    ensureManifest: () => null,
    receivesUnicode: async () => true,
    ...over,
  };
}

describe('the reader the PostgreSQL programs are @cap:installer-et-demarrer/moteur', () => {
  it('outside Windows: UTF-8, and nothing is written beside the binaries', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const reader = await resolvePostgresPathReader(
        FAKE_BINARIES,
        machine({
          platform,
          ensureManifest: () => {
            throw new Error('a manifest is a Windows thing');
          },
        }),
      );
      expect(reader).toEqual({ program: 'PostgreSQL', encoding: 'utf-8' });
    }
  });

  it('Windows, manifest in place and every program reading UTF-8: UTF-8', async () => {
    const reader = await resolvePostgresPathReader(FAKE_BINARIES, machine({}));
    expect(reader).toEqual({ program: 'PostgreSQL', encoding: 'utf-8' });
  });

  it('Windows, a manifest that cannot be written: ASCII only, saying which and why', async () => {
    const reader = await resolvePostgresPathReader(
      FAKE_BINARIES,
      machine({
        ensureManifest: (binary) =>
          binary.endsWith('postgres.exe') ? 'the folder is read-only (EACCES)' : null,
      }),
    );
    expect(reader).toEqual({
      program: 'PostgreSQL',
      encoding: 'ascii',
      why: 'the folder is read-only (EACCES)',
    });
  });

  it('Windows, one program still reading the ANSI code page: ASCII only, naming it', async () => {
    const reader = await resolvePostgresPathReader(
      FAKE_BINARIES,
      machine({ receivesUnicode: async (program) => program !== 'pg_ctl' }),
    );
    expect(reader.encoding).toBe('ascii');
    expect(reader.why).toMatch(/^pg_ctl\.exe still reads paths in this machine's ANSI code page/);
  });

  it('a manifest already right but newer than its exe: the exe is moved after it, once', () => {
    // The state a run killed between the write and the touch leaves, or another
    // tool: Windows keeps serving the context it cached without the manifest
    // until the exe changes, so this state must be repaired, not trusted.
    const dir = mkdtempSync(join(tmpdir(), 'nodal-manifest-'));
    try {
      const exe = join(dir, 'pg_ctl.exe');
      writeFileSync(exe, 'not a real program');
      writeFileSync(`${exe}.manifest`, UTF8_CODE_PAGE_MANIFEST, 'utf8');
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(exe, old, old);
      expect(ensureUtf8Manifest(exe)).toBeNull();
      const exeTime = statSync(exe).mtimeMs;
      expect(exeTime).toBeGreaterThan(statSync(`${exe}.manifest`).mtimeMs);
      // Already in order: left alone.
      expect(ensureUtf8Manifest(exe)).toBeNull();
      expect(statSync(exe).mtimeMs).toBe(exeTime);
      expect(readFileSync(exe, 'utf8')).toBe('not a real program');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a manifest that cannot be written says where', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-manifest-'));
    try {
      const reason = ensureUtf8Manifest(join(dir, 'missing folder', 'postgres.exe'));
      expect(reason).toMatch(
        /^the UTF-8 code page manifest could not be written beside postgres\.exe \(/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'win32')(
  'the real PostgreSQL programs of this install, on Windows @cap:installer-et-demarrer/moteur',
  () => {
    it('each has the UTF-8 manifest beside it and receives "é Ω 😀" exactly', async () => {
      const binaries = await postgresBinaryPaths();
      for (const name of POSTGRES_PROGRAMS) {
        expect(ensureUtf8Manifest(binaries[name])).toBeNull();
        expect(readFileSync(`${binaries[name]}.manifest`, 'utf8')).toBe(UTF8_CODE_PAGE_MANIFEST);
        expect({ name, exact: await receivesUnicodeExactly(name, binaries[name]) }).toEqual({
          name,
          exact: true,
        });
      }
    }, 60_000);
  },
);
