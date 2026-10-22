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
const FAKE_PG_CTL = vi.hoisted(() => "/opt/O'Brien pg/bin/pg_ctl");

vi.mock('../lib/postgres.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/postgres.ts')>();
  return {
    ...original,
    // A fixed path with a space and an apostrophe: the printed lines must survive both.
    resolvePgCtl: async (): Promise<string | null> => FAKE_PG_CTL,
    stopOrphanPostgres: async (decidedPid: number): Promise<boolean> => {
      stops.pids.push(decidedPid);
      process.kill(decidedPid);
      return true;
    },
  };
});

import { spawn, type ChildProcess } from 'node:child_process';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  postgresStopByHandLines,
  runDown,
  stopPostgresGracefully,
  type DownResult,
  type KillContext,
} from '../commands/down.ts';
import { runReset } from '../commands/reset.ts';
import { CONFIG_DIR, PG_DATA_DIR } from '../lib/config.ts';
import { isPidAlive, waitForPidDead } from '../lib/processes.ts';
import { processTable } from './process-table-available.ts';

const lockfile = join(home, 'pg-data', 'postmaster.pid');

/** A PowerShell single-quoted literal, an inner apostrophe doubled. */
const psq = (value: string): string => `'${value.replace(/'/g, "''")}'`;

let stranger: ChildProcess;
let said: string[];
let printed: string[];

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
  // A `reset` case deletes the whole home: lay the data dir down again.
  mkdirSync(join(home, 'pg-data'), { recursive: true });
  said = [];
  printed = [];
  stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    said.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(((line: unknown) => {
    printed.push(String(line));
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A lone process with no children: a direct kill is enough, and it skips the
  // process-table enumeration `killPidTree` pays for (tens of seconds on CI).
  if (stranger.pid && isPidAlive(stranger.pid)) stranger.kill();
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

    expect(stopped).toBe('unconfirmed');
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

    expect(stopped).toBe('foreign');
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

    expect(stopped).toBe('no-pid');
    expect(said.join('')).toContain('KILL_REFUSED code=POSTGRES_UNCONFIRMED');
    expect(stops.pids).toEqual([]);
  });

  it('leaves a stale lockfile whose pid is gone alone, and claims nothing', async () => {
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => dead.once('exit', resolve));
    expect(await waitForPidDead(dead.pid!, 5_000)).toBe(true);
    writeLockfile(dead.pid!);

    const stopped = await stopPostgresGracefully(context({}));

    expect(stopped).toBe('none');
    expect(stops.pids).toEqual([]);
    expect(existsSync(lockfile)).toBe(true);
  });

  it('stops a pid the probe OWNS', async () => {
    writeLockfile(stranger.pid!);

    const stopped = await stopPostgresGracefully(
      context({ ownedPostgresPids: new Set([stranger.pid!]), postgresReadingWorked: true }),
    );

    expect(stopped).toBe('stopped');
    expect(stops.pids).toEqual([stranger.pid]);
    expect(await waitForPidDead(stranger.pid!, 10_000)).toBe(true);
  });

  it('names the command to stop it by hand, with the REAL data dir, and says it will keep refusing', async () => {
    writeLockfile(stranger.pid!);

    await stopPostgresGracefully(context({ postgresReadingWorked: true }));

    const text = printed.join('\n');
    expect(text).toContain(
      process.platform === 'win32'
        ? `& ${psq(FAKE_PG_CTL)} stop -D ${psq(PG_DATA_DIR)} -m fast`
        : `"${FAKE_PG_CTL}" stop -D "${PG_DATA_DIR}" -m fast`,
    );
    expect(text).toContain(
      process.platform === 'win32'
        ? `Stop-Process -Id ${stranger.pid} -Force`
        : `kill ${stranger.pid}`,
    );
    expect(text).toContain('will keep refusing this pid until its ownership can be proven');
    expect(text).toContain('#840');
    // Said, not done.
    expect(isPidAlive(stranger.pid!)).toBe(true);
    expect(stops.pids).toEqual([]);
  });
});

// The whole `runDown`, nothing injected: the reading is the real probe, which
// cannot own a process that is not a postmaster of this data dir.
const canRunDown = process.platform !== 'win32' || processTable.available;

describe('down summary when Postgres is refused @cap:installer-et-demarrer/moteur', () => {
  it.skipIf(!canRunDown)(
    'does not say stopped, names the postmaster, and returns it as unstopped',
    async () => {
      writeLockfile(stranger.pid!);

      const result = await runDown();

      const text = printed.join('\n');
      // The reason depends on whether the platform could read its process
      // table: a reading that disowned the pid, or no proof either way.
      expect(result.unstopped).toHaveLength(1);
      expect(result.unstopped[0]).toMatchObject({ service: 'postgres', pid: stranger.pid });
      expect(['foreign', 'unconfirmed']).toContain(result.unstopped[0]!.reason);
      expect(text).toContain('NOT everything was stopped');
      expect(text).toContain(`postgres (pid ${stranger.pid})`);
      expect(text).not.toContain('still running');
      expect(text).not.toContain('Nodal-Agents stopped');
      expect(text).not.toContain('No running Nodal-Agents processes found');
      expect(isPidAlive(stranger.pid!)).toBe(true);
      expect(stops.pids).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!canRunDown)(
    'the CLI exits non-zero and prints the same summary',
    async () => {
      writeLockfile(stranger.pid!);
      const cliDir = fileURLToPath(new URL('../..', import.meta.url));

      const run = await execa(
        process.execPath,
        ['--import', 'tsx', join(cliDir, 'src', 'index.ts'), 'down'],
        {
          cwd: cliDir,
          env: { NODALAI_HOME: home },
          extendEnv: true,
          reject: false,
          timeout: 110_000,
        },
      );

      expect(run.exitCode).toBe(1);
      expect(run.stdout).toContain('NOT everything was stopped');
      expect(run.stdout).not.toContain('Nodal-Agents stopped');
      expect(run.stderr).toContain(`KILL_REFUSED`);
      expect(isPidAlive(stranger.pid!)).toBe(true);
    },
    120_000,
  );

  it.skipIf(!canRunDown)(
    'a lockfile that names no pid is reported as that, never as "still running"',
    async () => {
      writeFileSync(lockfile, 'garbage\n', 'utf-8');

      const result = await runDown();

      const text = printed.join('\n');
      expect(result.unstopped).toEqual([{ service: 'postgres', pid: null, reason: 'no-pid' }]);
      expect(text).toContain('postgres: postmaster.pid names no readable pid');
      expect(text).not.toContain('still running');
      expect(text).not.toContain('pid unknown');
    },
    120_000,
  );
});

describe('the by-hand stop line runs as printed in the default shell @cap:installer-et-demarrer/moteur', () => {
  let platform: PropertyDescriptor | undefined;
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
  });
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  it('on Windows it is a PowerShell call: & operator, single-quoted literals, -Force last resort', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const lines = await postgresStopByHandLines(4242);

    // A quoted string in command position is an EXPRESSION in PowerShell: the
    // line must start the command with `&`. Apostrophes (a user named O'Brien)
    // are doubled, and `$` in a path stays literal inside single quotes.
    expect(lines[0]).toBe(
      `    1. (PowerShell) & ${psq(FAKE_PG_CTL)} stop -D ${psq(PG_DATA_DIR)} -m fast`,
    );
    expect(lines[0]).toContain("& '/opt/O''Brien pg/bin/pg_ctl' stop -D '");
    expect(lines[1]).toBe('    2. as a last resort: powershell Stop-Process -Id 4242 -Force');
  });

  it('elsewhere it is the sh form, with the root warning, and kill as the last resort', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const lines = await postgresStopByHandLines(4242);

    expect(lines[0]).toBe(`    1. "${FAKE_PG_CTL}" stop -D "${PG_DATA_DIR}" -m fast`);
    expect(lines.join('\n')).toContain('pg_ctl refuses to run as root');
    expect(lines.at(-1)).toBe('    2. as a last resort: kill 4242');
  });

  it('with no pid there is no last resort to print', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const lines = await postgresStopByHandLines(null);

    expect(lines).toHaveLength(1);
  });
});

// `reset` decides from the REASON `down` gives, one rule. `down` is injected so
// that every reason is exercised on every platform.
describe('reset decides from why a service was not stopped @cap:installer-et-demarrer/moteur', () => {
  const downSays =
    (...unstopped: DownResult['unstopped']) =>
    async (): Promise<DownResult> => ({
      unstopped,
    });

  it('completes when the only leftover is a postmaster a reading PROVED is not ours, and never touches it', async () => {
    writeLockfile(stranger.pid!);

    await runReset(
      { yes: true },
      downSays({ service: 'postgres', pid: stranger.pid!, reason: 'foreign' }),
    );

    expect(existsSync(CONFIG_DIR)).toBe(false);
    expect(isPidAlive(stranger.pid!)).toBe(true);
    expect(stops.pids).toEqual([]);
  });

  it('blocks on our own postmaster that is still running, and prints how to stop it', async () => {
    writeLockfile(stranger.pid!);

    const run = runReset(
      { yes: true },
      downSays({ service: 'postgres', pid: stranger.pid!, reason: 'running' }),
    );

    await expect(run).rejects.toThrow(/Nothing was deleted/);
    await expect(run).rejects.toThrow(/stop -D/);
    expect(existsSync(lockfile)).toBe(true);
  });

  it('blocks on a postmaster nothing could confirm (macOS, #840), with the commands', async () => {
    writeLockfile(stranger.pid!);

    const run = runReset(
      { yes: true },
      downSays({ service: 'postgres', pid: stranger.pid!, reason: 'unconfirmed' }),
    );

    await expect(run).rejects.toThrow(/could not be confirmed as this install's postmaster/);
    await expect(run).rejects.toThrow(/as a last resort/);
    expect(existsSync(lockfile)).toBe(true);
  });

  it('blocks on a lockfile with no readable pid, and the remedy is to delete the file, not to "stop" anything', async () => {
    writeFileSync(lockfile, 'garbage\n', 'utf-8');

    const run = runReset(
      { yes: true },
      downSays({ service: 'postgres', pid: null, reason: 'no-pid' }),
    );

    await expect(run).rejects.toThrow(/delete .*postmaster\.pid yourself/);
    await expect(run).rejects.not.toThrow(/stop -D/);
    expect(existsSync(lockfile)).toBe(true);
  });

  it('blocks on a runner nothing identifies, and says how to look at it', async () => {
    const run = runReset(
      { yes: true },
      downSays({ service: 'runner', pid: stranger.pid!, reason: 'unidentified' }),
    );

    await expect(run).rejects.toThrow(/runner \(pid \d+\): nothing identifies it/);
    await expect(run).rejects.toThrow(/Look at it:/);
    expect(existsSync(CONFIG_DIR)).toBe(true);
  });

  it('a foreign postmaster does not excuse a runner that still runs', async () => {
    const run = runReset(
      { yes: true },
      downSays(
        { service: 'postgres', pid: stranger.pid!, reason: 'foreign' },
        { service: 'runner', pid: stranger.pid!, reason: 'running' },
      ),
    );

    await expect(run).rejects.toThrow(/Nothing was deleted/);
    expect(existsSync(CONFIG_DIR)).toBe(true);
  });

  it('completes when down left nothing', async () => {
    await runReset({ yes: true }, downSays());

    expect(existsSync(CONFIG_DIR)).toBe(false);
  });
});
