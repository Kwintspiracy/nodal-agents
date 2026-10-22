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

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeClaimedPostmaster, type LockfileClaim } from '../lib/orphans.ts';
import {
  postgresProcessesForDataDir,
  unconfirmedReading,
  type SinglePidProbes,
} from '../lib/postgres.ts';

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

  it('UNKNOWN when the pid is merely ABSENT from the list: absence is never a disproof', () => {
    // A partial read that still exits 0 lists another install's postgres and
    // misses our live postmaster. Whatever else is listed, a list cannot
    // disprove a pid it does not show.
    const v = judgeClaimedPostmaster({
      rows: [row(PID + 1, STARTED_MS)],
      tableRead: true,
      claim: claim(STARTED_S),
    });
    expect(v.verdict).toBe('unknown');
    expect(v.reason).toContain('a list cannot disprove it');
  });

  it('NOT ours when a DIRECT query about this pid says it is another program', () => {
    const v = judgeClaimedPostmaster({
      rows: [row(PID + 1, STARTED_MS)],
      tableRead: true,
      claim: claim(STARTED_S),
      direct: { exe: 'node.exe', startedAt: STARTED_MS },
    });
    expect(v.verdict).toBe('not-ours');
    expect(v.reason).toContain('node.exe');
  });

  it('a DIRECT query that finds a postgres is judged like a row: dates agree -> ours, a date missing -> unknown', () => {
    const base = { rows: [row(PID + 1)], tableRead: true, claim: claim(STARTED_S) };
    expect(
      judgeClaimedPostmaster({ ...base, direct: { exe: 'postgres.exe', startedAt: STARTED_MS } })
        .verdict,
    ).toBe('ours');
    expect(judgeClaimedPostmaster({ ...base, direct: { exe: 'postgres.exe' } }).verdict).toBe(
      'unknown',
    );
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

// The Windows reading, end to end, with WMI answered by a stand-in: the list can
// only CONFIRM; a pid it does not show is asked about DIRECTLY, and only a
// positive answer about that pid can disprove the claim.
describe('postgresProcessesForDataDir on Windows: absence from the list proves nothing @cap:installer-et-demarrer/moteur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-verdict-win-'));
  let original: PropertyDescriptor | undefined;
  const mockExeca = vi.mocked(execa);

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    writeFileSync(
      join(dir, 'postmaster.pid'),
      `${PID}
${dir}
${STARTED_S}
`,
      'utf-8',
    );
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });
  afterEach(() => {
    if (original) Object.defineProperty(process, 'platform', original);
    vi.restoreAllMocks();
    mockExeca.mockReset();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** WMI stand-in: the LIST lists another install's postgres only. */
  function wmi(direct: { exitCode: number; stdout: string }): void {
    mockExeca.mockImplementation(((_file: string, args: string[]) => {
      const command = args.at(-1) ?? '';
      if (command.includes('ProcessId=')) {
        return Promise.resolve({ ...direct, stderr: '' });
      }
      return Promise.resolve({
        stdout: `5555|1|${STARTED_MS}|postgres -D C:/other/install`,
        stderr: '',
        exitCode: 0,
      });
    }) as unknown as typeof execa);
  }

  it('a partial list that misses our pid, and a direct query that does not answer: UNKNOWN, not "stale"', async () => {
    wmi({ exitCode: 1, stdout: '' });

    const reading = await postgresProcessesForDataDir(dir);

    expect(reading.read).toBe(true);
    expect(reading.claim.verdict).toBe('unknown');
    expect(reading.owned).toEqual([]);
  });

  it('a direct query that finds ANOTHER program under the pid: NOT ours', async () => {
    wmi({
      exitCode: 0,
      stdout: `node.exe|${STARTED_MS}
`,
    });

    const reading = await postgresProcessesForDataDir(dir);

    expect(reading.claim.verdict).toBe('not-ours');
    expect(reading.claim.reason).toContain('node.exe');
  });

  it('a direct query that finds our postgres the list had dropped: OURS', async () => {
    wmi({
      exitCode: 0,
      stdout: `postgres.exe|${STARTED_MS + 120}
`,
    });

    const reading = await postgresProcessesForDataDir(dir);

    expect(reading.claim.verdict).toBe('ours');
    expect(reading.owned).toContain(PID);
  });
});
