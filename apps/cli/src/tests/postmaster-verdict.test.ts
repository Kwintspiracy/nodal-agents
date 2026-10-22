// postmaster-verdict.test.ts — "not proven ours" is not "proven not ours" (#831,
// review pass 4).
//
// The pid a lockfile names is judged THREE ways: `ours` (every proof held),
// `not-ours` (a disproof was actually obtained) and `unknown` (anything missing
// or unreadable). `reset` goes on without waiting for a stranger only on the
// second; the first and the third keep it from deleting a data dir under a
// postmaster that may be live. A missing date is NEVER a mismatch.
//
// Pure rows for the Windows reading; the Linux/macOS single-pid reading takes
// its three OS questions as injected probes, so every case runs on every
// platform. The lockfile is a real file under a temp directory.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeClaimedPostmaster, type LockfileClaim } from '../lib/orphans.ts';
import { unconfirmedReading, type SinglePidProbes } from '../lib/postgres.ts';

const PID = 4242;
const STARTED_S = 1_790_000_000;
const STARTED_MS = STARTED_S * 1000;
const claim = (startedAtSeconds: number | null): LockfileClaim => ({ pid: PID, startedAtSeconds });
const row = (pid: number, startedAt?: number) => ({
  pid,
  ppid: 1,
  commandLine: '',
  ...(startedAt === undefined ? {} : { startedAt }),
});

describe('judgeClaimedPostmaster @cap:installer-et-demarrer/moteur', () => {
  it('ours: a live postgres whose creation date matches the lockfile', () => {
    const v = judgeClaimedPostmaster({
      rows: [row(PID, STARTED_MS + 300)],
      tableRead: true,
      claim: claim(STARTED_S),
    });
    expect(v.verdict).toBe('ours');
  });

  it('UNKNOWN, not a mismatch, when the process row has no creation date', () => {
    const v = judgeClaimedPostmaster({
      rows: [row(PID)],
      tableRead: true,
      claim: claim(STARTED_S),
    });
    expect(v.verdict).toBe('unknown');
    expect(v.reason).toContain('a date is missing');
  });

  it('UNKNOWN, not a mismatch, when the lockfile carries no start time (no line 3)', () => {
    const v = judgeClaimedPostmaster({
      rows: [row(PID, STARTED_MS)],
      tableRead: true,
      claim: claim(null),
    });
    expect(v.verdict).toBe('unknown');
  });

  it('NOT ours when both dates are known and disagree', () => {
    const v = judgeClaimedPostmaster({
      rows: [row(PID, STARTED_MS + 60_000)],
      tableRead: true,
      claim: claim(STARTED_S),
    });
    expect(v.verdict).toBe('not-ours');
  });

  it('NOT ours when the table was read, lists other postgres, and not this pid', () => {
    const v = judgeClaimedPostmaster({
      rows: [row(PID + 1, STARTED_MS)],
      tableRead: true,
      claim: claim(STARTED_S),
    });
    expect(v.verdict).toBe('not-ours');
  });

  it('UNKNOWN when the table lists no postgres at all: a failed query looks the same', () => {
    const v = judgeClaimedPostmaster({ rows: [], tableRead: true, claim: claim(STARTED_S) });
    expect(v.verdict).toBe('unknown');
  });

  it('UNKNOWN when the table could not be read, or nothing claims the data dir', () => {
    expect(
      judgeClaimedPostmaster({ rows: [], tableRead: false, claim: claim(STARTED_S) }).verdict,
    ).toBe('unknown');
    expect(
      judgeClaimedPostmaster({ rows: [row(PID, STARTED_MS)], tableRead: true, claim: null })
        .verdict,
    ).toBe('unknown');
  });
});

describe('unconfirmedReading (no table: one pid, three OS questions) @cap:installer-et-demarrer/moteur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-verdict-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function lockfile(line3: string | null): void {
    const lines = [String(PID), dir];
    if (line3 !== null) lines.push(line3);
    writeFileSync(join(dir, 'postmaster.pid'), lines.join('\n') + '\n', 'utf-8');
  }
  const probes = (over: Partial<SinglePidProbes>): SinglePidProbes => ({
    isRunning: () => true,
    holdsDataDir: () => true,
    startedAtMs: () => STARTED_MS,
    ...over,
  });
  const quiet = () => vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

  it('ours: runs out of the data dir and the dates agree', () => {
    lockfile(String(STARTED_S));
    const spy = quiet();
    const r = unconfirmedReading(dir, probes({}));
    spy.mockRestore();
    expect(r.claim.verdict).toBe('ours');
    expect(r.owned).toEqual([PID]);
  });

  it('NOT ours: the kernel says the process runs out of ANOTHER directory', () => {
    lockfile(String(STARTED_S));
    const spy = quiet();
    const r = unconfirmedReading(dir, probes({ holdsDataDir: () => false }));
    spy.mockRestore();
    expect(r.claim.verdict).toBe('not-ours');
    expect(r.owned).toEqual([]);
  });

  it('UNKNOWN: the platform cannot say which directory the process runs out of', () => {
    lockfile(String(STARTED_S));
    const spy = quiet();
    const r = unconfirmedReading(dir, probes({ holdsDataDir: () => null }));
    spy.mockRestore();
    expect(r.claim.verdict).toBe('unknown');
  });

  it('UNKNOWN: the start time cannot be read, or the lockfile has no line 3', () => {
    const spy = quiet();
    lockfile(String(STARTED_S));
    expect(unconfirmedReading(dir, probes({ startedAtMs: () => null })).claim.verdict).toBe(
      'unknown',
    );
    lockfile(null);
    expect(unconfirmedReading(dir, probes({})).claim.verdict).toBe('unknown');
    spy.mockRestore();
  });

  it('NOT ours: both dates known and apart', () => {
    lockfile(String(STARTED_S));
    const spy = quiet();
    const r = unconfirmedReading(dir, probes({ startedAtMs: () => STARTED_MS + 3_600_000 }));
    spy.mockRestore();
    expect(r.claim.verdict).toBe('not-ours');
  });

  it('NOT ours: the claimed pid is not running at all', () => {
    lockfile(String(STARTED_S));
    const spy = quiet();
    const r = unconfirmedReading(dir, probes({ isRunning: () => false }));
    spy.mockRestore();
    expect(r.claim.verdict).toBe('not-ours');
  });
});
