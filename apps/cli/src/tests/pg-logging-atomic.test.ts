// pg-logging-atomic.test.ts — `postgresql.auto.conf` is replaced whole, or not
// at all (review of PR #114, 2026-09-16).
//
// `applyPostgresLoggingConfig` runs on EVERY start, and it used to call
// `writeFileSync` straight at the target. `writeFileSync` truncates the file
// and then writes it: a crash, a full disk or a kill in between leaves a
// TRUNCATED auto.conf, Postgres refuses to parse it, and — because this runs on
// every start — the cluster is then locked out of every future boot, not just
// the interrupted one. The loss is worse than the incident.
//
// So the content goes to a scratch file in the SAME directory (rename is atomic
// only within a filesystem) and is renamed over the target.
//
// What these cases can and cannot prove is worth stating. A test cannot induce
// a real power cut, so the intermediate truncated state is not observable from
// here. What IS observable, and what the mutation flips, is WHICH PATH the
// bytes are written to and whether a rename happens at all — asserted on the
// real argument arrays handed to `node:fs`, plus the real directory left on
// disk afterwards.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as NodeFs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  return {
    ...real,
    default: real,
    writeFileSync: vi.fn(real.writeFileSync),
    renameSync: vi.fn(real.renameSync),
  };
});

import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPostgresLoggingConfig, tempConfPath } from '../lib/pg-logging.ts';

const mockWrite = vi.mocked(writeFileSync);
const mockRename = vi.mocked(renameSync);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nodal-pgatomic-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Every path `writeFileSync` was aimed at, as a string. */
function writtenPaths(): string[] {
  return mockWrite.mock.calls.map((c) => String(c[0]));
}

describe('applyPostgresLoggingConfig — atomic replace @cap:installer-et-demarrer/moteur', () => {
  it('writes the scratch file, never the target, and renames it into place', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), 'logs');
    const target = join(dataDir, 'postgresql.auto.conf');

    applyPostgresLoggingConfig(dataDir, logDir);

    // The bytes never go to the target directly — that is the whole fix.
    expect(writtenPaths()).toContain(tempConfPath(target));
    expect(writtenPaths()).not.toContain(target);
    expect(mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])])).toContainEqual([
      tempConfPath(target),
      target,
    ]);
  });

  it('leaves a complete file and no scratch file behind', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), 'logs');

    applyPostgresLoggingConfig(dataDir, logDir);

    expect(readdirSync(dataDir)).toEqual(['postgresql.auto.conf']);
    const written = readFileSync(join(dataDir, 'postgresql.auto.conf'), 'utf-8');
    // Complete means every managed setting AND a closing newline: a reader
    // cannot tell a half-written file from a short one except by its content.
    expect(written).toContain("logging_collector = 'on'");
    expect(written).toContain("log_min_messages = 'warning'");
    expect(written).toContain("restart_after_crash = 'on'");
    expect(written.endsWith('\n')).toBe(true);
  });

  it('keeps the previous file when the rename fails, and leaves no scratch file', () => {
    const dataDir = tempDir();
    const logDir = join(tempDir(), 'logs');
    const target = join(dataDir, 'postgresql.auto.conf');
    // A file the cluster is booting from right now. Replacing it badly is the
    // failure this whole file is about.
    const before = "shared_buffers = '128MB'\n";
    writeFileSync(target, before, 'utf-8');

    mockRename.mockImplementationOnce(() => {
      throw new Error('EPERM: the file is held open');
    });

    expect(() => applyPostgresLoggingConfig(dataDir, logDir)).toThrow(/EPERM/);
    // Nothing half-written is left lying next to the data directory.
    expect(readdirSync(dataDir)).toEqual(['postgresql.auto.conf']);
    // And it is the OLD one, untouched: a failed replace replaces nothing.
    expect(readFileSync(target, 'utf-8')).toBe(before);
  });
});
