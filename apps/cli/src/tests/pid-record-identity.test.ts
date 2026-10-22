// pid-record-identity.test.ts — a service is on record WITH its identity, from
// the moment it is spawned (#767).
//
// The defect. `up` wrote `{ runner, web }` as bare numbers right after the
// spawn, and the identity (creation tick + executable name) arrived only after
// the health checks, one PowerShell enumeration later. A `down` run the moment
// the web answered — `scripts/smoke-pack.mjs` does exactly that — read bare
// numbers and refused, correctly, to stop its own stack:
// `KILL_REFUSED code=IDENTITY_NOT_RECORDED`. The refusal is right (it guards
// against a recycled pid); the WRITER was wrong, so the writer is what changes:
// `recordServiceTree` is the only function that records a start, and `up` calls
// it at the spawn.
//
// The process table is mocked at the `execa` boundary (as in
// kill-tree-refusal.test.ts), so the Linux CI job runs every case. The pid file
// is a REAL file under a temp NODALAI_HOME and is read back from disk: the
// assertions are on what `down` would find there, never on how often a function
// was called.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// PID_DIR is computed when config.ts loads; the home must exist before any
// import. Never the owner's `~/.nodalai`.
const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-pid-identity-'));
  fs.mkdirSync(path.join(dir, 'pids'), { recursive: true });
  process.env['NODALAI_HOME'] = dir;
  return dir;
});

vi.mock('execa', () => ({ execa: vi.fn() }));

import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  clearPids,
  readPids,
  recordServiceTree,
  recordedRoot,
  retainPids,
} from '../lib/processes.ts';
import { confirmRecordedPid } from '../lib/pid-confirm.ts';

const mockExeca = vi.mocked(execa);

const RUNNER = 4_001;
const WEB = 4_002;
const RUNNER_TICK = '638100000000000001';
const WEB_TICK = '638100000000000002';
const CHILD = 4_003;

let originalPlatform: PropertyDescriptor | undefined;

/** The table `up` would read right after the spawn: both roots, one child. */
const spawnTimeRows = [
  `${RUNNER}|1|${RUNNER_TICK}|node.exe`,
  `${WEB}|1|${WEB_TICK}|cmd.exe`,
  `${CHILD}|${WEB}|638100000000000003|node.exe`,
];

function tableAnswers(rows: string[]): void {
  mockExeca.mockImplementation(((file: string) => {
    if (file === 'powershell') {
      return Promise.resolve({
        stdout: rows.join('\r\n'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
  }) as unknown as typeof execa);
}

function tableDown(): void {
  mockExeca.mockImplementation((() =>
    Promise.resolve({
      stdout: '',
      stderr: 'access denied',
      exitCode: 1,
      timedOut: false,
    })) as unknown as typeof execa);
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  clearPids();
  // The table-read warning goes to stderr; this file reads it, never shows it.
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('recording a start @cap:installer-et-demarrer/moteur', () => {
  it('writes the creation tick and executable name of runner AND web, with the pids', async () => {
    setPlatform('win32');
    tableAnswers(spawnTimeRows);

    const outcome = await recordServiceTree({ runner: RUNNER, web: WEB });

    expect(outcome).toEqual({
      identified: [RUNNER, WEB],
      unidentified: [],
      tableAvailable: true,
    });
    // What `down` finds on disk — not what the function returned.
    const onDisk = readPids();
    expect(onDisk?.runner).toBe(RUNNER);
    expect(onDisk?.web).toBe(WEB);
    expect(recordedRoot(onDisk, RUNNER)).toEqual({
      pid: RUNNER,
      startedAt: RUNNER_TICK,
      name: 'node.exe',
    });
    expect(recordedRoot(onDisk, WEB)).toEqual({
      pid: WEB,
      startedAt: WEB_TICK,
      name: 'cmd.exe',
    });
    expect(onDisk?.children?.map((c) => c.pid)).toEqual([CHILD]);
  });

  it('what it wrote is what makes `down` allowed to stop them', async () => {
    setPlatform('win32');
    tableAnswers(spawnTimeRows);
    await recordServiceTree({ runner: RUNNER, web: WEB });
    const onDisk = readPids();

    for (const [pid, tick, name] of [
      [RUNNER, RUNNER_TICK, 'node.exe'],
      [WEB, WEB_TICK, 'cmd.exe'],
    ] as const) {
      const verdict = confirmRecordedPid({
        recorded: recordedRoot(onDisk, pid),
        live: { pid, startedAt: tick, name },
        tableRead: true,
        ownedPostgresPids: new Set(),
      });
      expect(verdict).toEqual({ killable: true });
    }
  });

  it('a pid recorded as a bare number is still refused — the refusal is untouched', () => {
    // The shape a pid file had before #767, and the shape of an old install.
    const verdict = confirmRecordedPid({
      recorded: recordedRoot({ runner: RUNNER, web: WEB }, RUNNER),
      live: { pid: RUNNER, startedAt: RUNNER_TICK, name: 'node.exe' },
      tableRead: true,
      ownedPostgresPids: new Set(),
    });
    expect(verdict).toMatchObject({ killable: false, code: 'IDENTITY_NOT_RECORDED' });
  });

  it('refreshing after the health check completes the tree and keeps the identities', async () => {
    setPlatform('win32');
    // Right after the spawn only the roots exist...
    tableAnswers(spawnTimeRows.slice(0, 2));
    await recordServiceTree({ runner: RUNNER, web: WEB });
    expect(readPids()?.children).toEqual([]);
    // ...once healthy the child is there, and the same writer records it.
    tableAnswers(spawnTimeRows);
    await recordServiceTree({ runner: RUNNER, web: WEB });
    const onDisk = readPids();
    expect(onDisk?.children?.map((c) => c.pid)).toEqual([CHILD]);
    expect(recordedRoot(onDisk, RUNNER).startedAt).toBe(RUNNER_TICK);
  });

  it('an unreadable table is reported, and the pids are still written for `down` to refuse by name', async () => {
    setPlatform('win32');
    tableDown();

    const outcome = await recordServiceTree({ runner: RUNNER, web: WEB });

    expect(outcome).toEqual({
      identified: [],
      unidentified: [RUNNER, WEB],
      tableAvailable: true,
    });
    const onDisk = readPids();
    expect(onDisk?.runner).toBe(RUNNER);
    expect(onDisk?.web).toBe(WEB);
    expect(onDisk?.roots ?? []).toEqual([]);
  });

  it('a failed refresh never erases the identities a good reading wrote', async () => {
    setPlatform('win32');
    tableAnswers(spawnTimeRows);
    await recordServiceTree({ runner: RUNNER, web: WEB });

    tableDown();
    const outcome = await recordServiceTree({ runner: RUNNER, web: WEB });

    expect(outcome.unidentified).toEqual([]);
    expect(recordedRoot(readPids(), RUNNER)).toEqual({
      pid: RUNNER,
      startedAt: RUNNER_TICK,
      name: 'node.exe',
    });
    expect(recordedRoot(readPids(), WEB).startedAt).toBe(WEB_TICK);
  });

  it('a root the table does not list is reported as unidentified, the other one is not', async () => {
    setPlatform('win32');
    tableAnswers([`${RUNNER}|1|${RUNNER_TICK}|node.exe`]);

    const outcome = await recordServiceTree({ runner: RUNNER, web: WEB });

    expect(outcome.identified).toEqual([RUNNER]);
    expect(outcome.unidentified).toEqual([WEB]);
    expect(recordedRoot(readPids(), WEB)).toEqual({ pid: WEB });
  });

  it('off Windows the pids are written as they are, and nothing is reported as missing', async () => {
    setPlatform('linux');

    const outcome = await recordServiceTree({ runner: RUNNER, web: WEB });

    expect(outcome).toEqual({ identified: [], unidentified: [], tableAvailable: false });
    expect(readPids()).toEqual({ runner: RUNNER, web: WEB });
    // No process table was ever asked.
    expect(mockExeca).not.toHaveBeenCalled();
  });
});

describe('keeping the record of a stack down could not stop @cap:installer-et-demarrer/moteur', () => {
  it('retains only the pids still running, with their identity', async () => {
    setPlatform('win32');
    tableAnswers(spawnTimeRows);
    await recordServiceTree({ runner: RUNNER, web: WEB });
    const full = readPids();
    expect(full).not.toBeNull();

    retainPids(full!, new Set([WEB]));

    const kept = readPids();
    expect(kept?.runner).toBeUndefined();
    expect(kept?.web).toBe(WEB);
    expect(kept?.roots?.map((r) => r.pid)).toEqual([WEB]);
  });
});

describe('the writer of a start is one, and `up` calls it at the spawn @cap:installer-et-demarrer/moteur', () => {
  // Structural, said as such: `up` cannot be run inside a unit test (it boots a
  // database, a runner and a web). What this pins is the ORDER that closed the
  // race — the identity is recorded before the health wait, not after — and
  // that no second writer exists. The behaviour behind it is proven above and
  // in down-fresh-record.test.ts.
  const src = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

  it('no bare `writePids` exists outside processes.ts', async () => {
    const processes = await import('../lib/processes.ts');
    expect('writePids' in processes).toBe(false);
    for (const file of ['../commands/up.ts', '../commands/down.ts']) {
      expect(src(file)).not.toMatch(/writePids/);
    }
  });

  it('up records the services before it starts waiting for them to be healthy', () => {
    const up = src('../commands/up.ts');
    const firstRecord = up.indexOf('recordServiceTree(');
    const firstWait = up.indexOf('waitForHealth(runnerUrl');
    expect(firstRecord).toBeGreaterThan(-1);
    expect(firstWait).toBeGreaterThan(-1);
    expect(firstRecord).toBeLessThan(firstWait);
  });
});
