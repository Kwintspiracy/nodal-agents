// down-postgres-ownership.test.ts — `down` signals a Postgres pid only when the
// ownership probe OWNS it (#767, review pass 1).
//
// `pg_ctl stop` re-reads `postmaster.pid` and signals whatever pid it names, so
// a lockfile left by a crashed postmaster, whose pid the OS has since handed to
// a stranger, would get a SIGTERM from `down`. The probe is the one place that
// knows: `postgresProcessesForDataDir` returns the pids it can PROVE are ours,
// and `unconfirmedReading` (macOS, Linux without proof, WMI down) returns an
// empty set with `read: false` — an answer, not a licence.
//
// The reading is INJECTED through the `KillContext`, so every case runs on the
// default Linux CI as well as on Windows: nothing here asks the OS anything.
// The stranger is a real process, the lockfile a real file under a temp
// NODALAI_HOME (never the owner's `~/.nodalai`); what is asserted is the
// refusal line, the stranger still alive and the lockfile untouched. The stop
// itself is replaced at the module boundary — the one thing that must NOT happen
// in the refusal cases is for it to be reached.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-down-pgown-'));
  fs.mkdirSync(path.join(dir, 'pg-data'), { recursive: true });
  process.env['NODALAI_HOME'] = dir;
  return dir;
});

// A signal-sent record, not a call count: the fake stop does what the real one
// does to its target (ends it), so a case that wrongly reaches it also ends the
// stranger and the "still alive" assertions go red.
const stops = vi.hoisted(() => ({ pids: [] as number[] }));

vi.mock('../lib/postgres.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/postgres.ts')>();
  return {
    ...original,
    stopOrphanPostgres: async (decidedPid: number): Promise<boolean> => {
      stops.pids.push(decidedPid);
      process.kill(decidedPid);
      return true;
    },
  };
});

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopPostgresGracefully, type KillContext } from '../commands/down.ts';
import { isPidAlive, killPidTree, waitForPidDead } from '../lib/processes.ts';

const lockfile = join(home, 'pg-data', 'postmaster.pid');

let stranger: ChildProcess;
let said: string[];

function context(overrides: Partial<KillContext>): KillContext {
  return {
    pids: null,
    snapshot: new Map(),
    ownedPostgresPids: new Set(),
    tableAvailable: process.platform === 'win32',
    postgresReadingWorked: false,
    ...overrides,
  };
}

/** A lockfile in the shape a postmaster writes: pid, data dir, start time. */
function writeLockfile(pid: number): void {
  writeFileSync(lockfile, `${pid}\n${join(home, 'pg-data')}\n${Date.now()}\n`, 'utf-8');
}

beforeEach(() => {
  stops.pids.length = 0;
  said = [];
  stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    said.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (stranger.pid && isPidAlive(stranger.pid)) await killPidTree(stranger.pid);
  rmSync(lockfile, { force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('down and the postmaster named by the lockfile @cap:installer-et-demarrer/moteur', () => {
  it('refuses a pid the reading could not take (no table): nothing is signalled', async () => {
    writeLockfile(stranger.pid!);

    const stopped = await stopPostgresGracefully(
      context({ ownedPostgresPids: new Set(), postgresReadingWorked: false }),
    );

    expect(stopped).toBe(false);
    expect(said.join('')).toContain(`KILL_REFUSED code=POSTGRES_UNCONFIRMED pid=${stranger.pid}`);
    expect(isPidAlive(stranger.pid!)).toBe(true);
    expect(stops.pids).toEqual([]);
    // The lockfile is left for the owner to read: `down` removed nothing.
    expect(readFileSync(lockfile, 'utf-8').split('\n')[0]).toBe(String(stranger.pid));
  });

  it('refuses a pid the reading took and disowned', async () => {
    writeLockfile(stranger.pid!);

    const stopped = await stopPostgresGracefully(
      context({ ownedPostgresPids: new Set(), postgresReadingWorked: true }),
    );

    expect(stopped).toBe(false);
    expect(said.join('')).toContain(`KILL_REFUSED code=FOREIGN_POSTGRES pid=${stranger.pid}`);
    expect(isPidAlive(stranger.pid!)).toBe(true);
    expect(stops.pids).toEqual([]);
  });

  it('refuses a pid that is owned by ANOTHER number: ownership is per pid', async () => {
    writeLockfile(stranger.pid!);

    await stopPostgresGracefully(
      context({ ownedPostgresPids: new Set([stranger.pid! + 1]), postgresReadingWorked: true }),
    );

    expect(isPidAlive(stranger.pid!)).toBe(true);
    expect(stops.pids).toEqual([]);
  });

  it('refuses a lockfile that names no pid, and does not claim a stop', async () => {
    writeFileSync(lockfile, 'garbage\n', 'utf-8');

    const stopped = await stopPostgresGracefully(context({}));

    expect(stopped).toBe(false);
    expect(said.join('')).toContain('KILL_REFUSED code=POSTGRES_UNCONFIRMED');
    expect(stops.pids).toEqual([]);
  });

  it('leaves a stale lockfile whose pid is gone alone, and claims nothing', async () => {
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('exit', resolve));
    expect(await waitForPidDead(dead.pid!, 5_000)).toBe(true);
    writeLockfile(dead.pid!);

    const stopped = await stopPostgresGracefully(context({}));

    expect(stopped).toBe(false);
    expect(stops.pids).toEqual([]);
    expect(existsSync(lockfile)).toBe(true);
  });

  it('stops a pid the probe OWNS', async () => {
    writeLockfile(stranger.pid!);

    const stopped = await stopPostgresGracefully(
      context({ ownedPostgresPids: new Set([stranger.pid!]), postgresReadingWorked: true }),
    );

    expect(stopped).toBe(true);
    expect(stops.pids).toEqual([stranger.pid]);
    expect(await waitForPidDead(stranger.pid!, 10_000)).toBe(true);
  });
});
