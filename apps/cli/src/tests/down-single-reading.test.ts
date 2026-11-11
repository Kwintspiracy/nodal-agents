// down-single-reading.test.ts — one `down`, one reading of the process table
// (#1046).
//
// On a slow Windows machine `down` read the table successfully, after 11.4 s,
// and confirmed the recorded runner and web. `killPidTree` then read it again
// for each pid, with a 6 s budget; every one of those looks timed out, and the
// two pids `down` had just identified were refused (`KILL_REFUSED
// code=TABLE_UNREADABLE`). The stack kept running.
//
// The process table is injected at the `execa` boundary, which is where every
// PowerShell query and every `taskkill` goes through, so these cases run on the
// Linux CI as well as on Windows. What is real: the runner, the web and their
// worker are live node processes; the pid record is a real file under a temp
// NODALAI_HOME (never the owner's `~/.nodalai`); `runDown` is the real one. The
// fake `taskkill` does to its target what the real one does — it ends it,
// through the stand-in's own handle and never by number (#841), and with `/T`
// it ends the whole tree as the injected table draws it. So a kill that should
// not have happened ends a process, and the "still alive" assertions go red.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-down-reading-'));
  fs.mkdirSync(path.join(dir, 'pids'), { recursive: true });
  process.env['NODALAI_HOME'] = dir;
  return dir;
});

vi.mock('execa', () => ({ execa: vi.fn() }));

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { runDown } from '../commands/down.ts';
import { isPidAlive, readPids, waitForPidDead, type ProcessRecord } from '../lib/processes.ts';

const mockExeca = vi.mocked(execa);

/** The line separator WMI emits. Assembled here so no shell can eat it. */
const EOL = String.fromCharCode(13, 10);

const TICK_RUNNER = '638000000000000001';
const TICK_WEB = '638000000000000002';
const TICK_WORKER = '638000000000000003';
const TICK_PG = '638000000000000004';

/** What one process-table query answers: rows, or a timeout. */
type Answer = ProcessRecord[] | 'timeout';

const standIns = new Map<number, ChildProcess>();
let taskkillArgs: string[][];
let said: string[];
let printed: string[];
let originalPlatform: PropertyDescriptor | undefined;

function spawnIdle(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  standIns.set(child.pid!, child);
  return child;
}

/**
 * Drive the process table: the Nth table query (CIM or WMI, one entry each)
 * gets the Nth answer, and the last one repeats. The postgres ownership probe
 * is a different query and finds no postgres at all, so nothing is owned.
 *
 * `taskkill` ends its target through the stand-in's handle, and returns once it
 * has exited; with `/T` it ends
 * every stand-in the FIRST answer draws under the target, as a real tree kill
 * would — the case that must never reach a foreign Postgres — except the pids
 * in `missedByTreeKill`: a Turbopack worker that re-parented is not in the tree
 * taskkill walks (CLI-03), and only `killPidTree`'s own walk can reach it.
 */
function drive(answers: readonly Answer[], missedByTreeKill: readonly number[] = []): void {
  let n = 0;
  const tree = answers.find((a): a is ProcessRecord[] => a !== 'timeout') ?? [];
  const subtree = (root: number): number[] => {
    const out = [root];
    for (let i = 0; i < out.length; i++) {
      for (const row of tree) if (row.ppid === out[i]) out.push(row.pid);
    }
    return out;
  };
  const ok = (stdout: string) =>
    Promise.resolve({ stdout, stderr: '', exitCode: 0, timedOut: false });
  mockExeca.mockImplementation(((file: string, args: readonly string[]) => {
    if (file === 'powershell') {
      const command = args[args.length - 1] ?? '';
      if (command.includes("Name='postgres.exe'")) return ok('');
      const answer = answers[Math.min(n, answers.length - 1)] ?? 'timeout';
      n += 1;
      if (answer === 'timeout') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: undefined, timedOut: true });
      }
      return ok(answer.map((r) => `${r.pid}|${r.ppid}|${r.startedAt}|${r.name ?? ''}`).join(EOL));
    }
    if (file === 'taskkill') {
      taskkillArgs.push([...args]);
      const target = Number(args[args.length - 1]);
      const victims = args.includes('/T')
        ? subtree(target).filter((pid) => !missedByTreeKill.includes(pid))
        : [target];
      // Returns once the victims are GONE, as `taskkill /F` does. Off Windows a
      // killed child stays a zombie until node reaps it, and signal 0 still
      // answers for a zombie: `down`'s re-probe right after the kill would then
      // read a dead stand-in as running (Linux CI, first run of this file).
      const gone = victims.flatMap((pid) => {
        const child = standIns.get(pid);
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return [];
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        return [exited];
      });
      return Promise.all(gone).then(() => ok(''));
    }
    return ok('');
  }) as unknown as typeof execa);
}

/** The pid record `recordServiceTree` writes for a start: numbers AND identities. */
function recordStart(runner: ProcessRecord, web: ProcessRecord): void {
  writeFileSync(
    join(home, 'pids', 'processes.json'),
    JSON.stringify({ runner: runner.pid, web: web.pid, roots: [runner, web] }),
    'utf-8',
  );
}

function row(child: ChildProcess, ppid: number, startedAt: string, name = 'node.exe') {
  return { pid: child.pid!, ppid, startedAt, name };
}

beforeEach(() => {
  vi.clearAllMocks();
  taskkillArgs = [];
  said = [];
  printed = [];
  // The branch under test is the Windows one; its table is injected, so the
  // OS underneath does not matter and the Linux CI runs these cases too.
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    said.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(((line: unknown) => {
    printed.push(String(line));
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  for (const child of standIns.values()) child.kill('SIGKILL');
  standIns.clear();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('down reads the process table once @cap:installer-et-demarrer/moteur', () => {
  it('stops runner, web and its worker when the first reading answers and every later one times out', async () => {
    const runner = spawnIdle();
    const web = spawnIdle();
    const worker = spawnIdle();
    const runnerRow = row(runner, 4, TICK_RUNNER);
    const webRow = row(web, 4, TICK_WEB);
    recordStart(runnerRow, webRow);
    // The slow machine of #1046: `down`'s reading answers, every look after it
    // times out. The worker is a descendant of the web, recorded nowhere: only
    // the tree walk on the held reading knows it exists, and `/T` misses it.
    drive([[runnerRow, webRow, row(worker, web.pid!, TICK_WORKER)], 'timeout'], [worker.pid!]);

    await runDown();

    expect(await waitForPidDead(runner.pid!, 5_000)).toBe(true);
    expect(await waitForPidDead(web.pid!, 5_000)).toBe(true);
    expect(await waitForPidDead(worker.pid!, 5_000)).toBe(true);
    expect(said.join('')).not.toContain('KILL_REFUSED');
    expect(printed.join('\n')).not.toContain('STILL RUNNING');
    // Everything stopped: nothing is kept on record.
    expect(readPids()).toEqual({});
  });

  it('refuses exactly as before when no reading answers: nothing signalled, record kept', async () => {
    const runner = spawnIdle();
    const web = spawnIdle();
    recordStart(row(runner, 4, TICK_RUNNER), row(web, 4, TICK_WEB));
    drive(['timeout']);

    await runDown();

    expect(taskkillArgs).toEqual([]);
    expect(isPidAlive(runner.pid!)).toBe(true);
    expect(isPidAlive(web.pid!)).toBe(true);
    const errors = said.join('');
    for (const pid of [runner.pid!, web.pid!]) {
      expect(errors).toContain(
        `KILL_REFUSED code=TABLE_UNREADABLE pid ${pid} could not be confirmed: ` +
          'the process table did not answer',
      );
    }
    const kept = readPids();
    expect(kept?.runner).toBe(runner.pid);
    expect(kept?.web).toBe(web.pid);
  });

  it('still vetoes `/T` over a foreign Postgres in the tree, on the held reading', async () => {
    const runner = spawnIdle();
    const web = spawnIdle();
    const foreignPg = spawnIdle();
    const runnerRow = row(runner, 4, TICK_RUNNER);
    const webRow = row(web, 4, TICK_WEB);
    recordStart(runnerRow, webRow);
    // A service of ours started a Postgres of its own against ANOTHER data
    // directory: the ownership probe claims nothing, so it is a stranger.
    drive([[runnerRow, webRow, row(foreignPg, runner.pid!, TICK_PG, 'postgres.exe')], 'timeout']);

    await runDown();

    // No tree kill on the runner: the fake `/T` would have ended the stranger.
    expect(taskkillArgs).toContainEqual(['/F', '/PID', String(runner.pid)]);
    expect(taskkillArgs.some((a) => a.includes('/T') && a.includes(String(runner.pid)))).toBe(
      false,
    );
    expect(taskkillArgs.some((a) => a.includes(String(foreignPg.pid)))).toBe(false);
    expect(isPidAlive(foreignPg.pid!)).toBe(true);
    expect(await waitForPidDead(runner.pid!, 5_000)).toBe(true);
    expect(await waitForPidDead(web.pid!, 5_000)).toBe(true);
    expect(said.join('')).toContain(`KILL_REFUSED code=FOREIGN_POSTGRES pid=${foreignPg.pid}`);
  });
  it('refuses the web when its number went to a stranger after the runner was killed', async () => {
    // Review pass 1 of #1046. The reading taken at the start confirms both.
    // The runner is killed; the web then exits on its own and Windows hands
    // its number to a stranger S (played by the stand-in, which the table now
    // reports as another executable of another generation). The look taken
    // after the runner's kill answers, and S must be refused: no signal at all
    // for that number, `/T` or not.
    const runner = spawnIdle();
    const stranger = spawnIdle();
    const runnerRow = row(runner, 4, TICK_RUNNER);
    const webRow = row(stranger, 4, TICK_WEB);
    recordStart(runnerRow, webRow);
    drive([[runnerRow, webRow], [{ ...webRow, startedAt: TICK_PG, name: 'chrome.exe' }]]);

    await runDown();

    expect(taskkillArgs.some((a) => a.includes(String(stranger.pid)))).toBe(false);
    expect(isPidAlive(stranger.pid!)).toBe(true);
    expect(said.join('')).toContain(`KILL_REFUSED code=BINARY_CHANGED pid ${stranger.pid}`);
    // Said as a refusal, never as a stop that failed.
    expect(printed.join('\n')).toContain(`web (pid ${stranger.pid}) was NOT stopped`);
    expect(printed.join('\n')).not.toContain('STILL RUNNING');
    expect(await waitForPidDead(runner.pid!, 5_000)).toBe(true);
    expect(readPids()?.web).toBe(stranger.pid);
  });

  it('stops the web on the held reading when the look after the runner kill does not answer', async () => {
    // The same start on the slow machine of #1046: the look times out, the
    // reading taken at the start still vouches for the web, and it is stopped.
    const runner = spawnIdle();
    const web = spawnIdle();
    const runnerRow = row(runner, 4, TICK_RUNNER);
    const webRow = row(web, 4, TICK_WEB);
    recordStart(runnerRow, webRow);
    drive([[runnerRow, webRow], 'timeout']);

    await runDown();

    expect(await waitForPidDead(runner.pid!, 5_000)).toBe(true);
    expect(await waitForPidDead(web.pid!, 5_000)).toBe(true);
    expect(said.join('')).not.toContain('KILL_REFUSED');
    expect(readPids()).toEqual({});
  });
});
