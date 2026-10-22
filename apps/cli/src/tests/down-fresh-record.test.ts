// down-fresh-record.test.ts — `down` against REAL processes, on a pid record
// written by the product's own writer (#767).
//
// Two stand-in node processes play the runner and the web (a test cannot boot
// the packed web). What is real: the processes, the process table, the pid file
// on disk, and `runDown` itself. A fresh start is recorded exactly as `up`
// records it — `recordServiceTree` right after the spawn — and `down` must then
// stop both. A record in the shape 0.9.7 could leave (bare numbers) must still
// be refused, the processes left alone, and the record kept so the next `down`
// says the same true thing instead of "No running Nodal-Agents processes found".
//
// Never the owner's `~/.nodalai`: NODALAI_HOME is a temp dir, set before the
// first import (PID_DIR and PG_DATA_DIR are computed at load).

import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-down-fresh-'));
  fs.mkdirSync(path.join(dir, 'pids'), { recursive: true });
  process.env['NODALAI_HOME'] = dir;
  return dir;
});

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDown } from '../commands/down.ts';
import {
  isPidAlive,
  killPidTree,
  readPids,
  recordServiceTree,
  waitForPidDead,
} from '../lib/processes.ts';
import { processTable } from './process-table-available.ts';

const onWindows = process.platform === 'win32';
// `down` needs a process table to confirm anything on Windows; GitHub's Windows
// runner has none (see process-table-available.ts), and off Windows there is
// nothing to confirm with, which is a different, documented branch.
const canRun = !onWindows || processTable.available;

const spawned: ChildProcess[] = [];

function spawnIdle(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  spawned.push(child);
  return child;
}

/** Run `down` with its console and stderr captured, so a refusal can be read. */
async function runDownCaptured(): Promise<{ stderr: string }> {
  const said: string[] = [];
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    said.push(String(chunk));
    return true;
  }) as never);
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runDown();
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
  return { stderr: said.join('') };
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.pid && isPidAlive(child.pid)) await killPidTree(child.pid);
  }
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('down after a fresh start @cap:installer-et-demarrer/moteur', () => {
  it.skipIf(!canRun)(
    'stops runner and web recorded at the spawn, before any health check',
    async () => {
      const runner = spawnIdle();
      const web = spawnIdle();
      // What `up` does right after spawning the two services — nothing else has
      // happened yet: no health check, no render check.
      await recordServiceTree({ runner: runner.pid!, web: web.pid! });
      expect(isPidAlive(runner.pid!)).toBe(true);
      expect(isPidAlive(web.pid!)).toBe(true);

      await runDownCaptured();

      expect(await waitForPidDead(runner.pid!, 15_000)).toBe(true);
      expect(await waitForPidDead(web.pid!, 15_000)).toBe(true);
      // Everything stopped: nothing is kept on record.
      expect(readPids()).toEqual({});
    },
    120_000,
  );

  it.skipIf(!onWindows || !processTable.available)(
    'a record of bare numbers is still refused: nothing is signalled and the record is kept',
    async () => {
      const runner = spawnIdle();
      const web = spawnIdle();
      // The shape 0.9.7 could leave behind: pids, no identity.
      writeFileSync(
        join(home, 'pids', 'processes.json'),
        JSON.stringify({ runner: runner.pid, web: web.pid }),
        'utf-8',
      );

      const { stderr } = await runDownCaptured();

      expect(isPidAlive(runner.pid!)).toBe(true);
      expect(isPidAlive(web.pid!)).toBe(true);
      expect(stderr).toContain(`KILL_REFUSED code=IDENTITY_NOT_RECORDED pid ${runner.pid}`);
      // The handle on the still-running stack is not erased by the refusal.
      const kept = readPids();
      expect(kept?.runner).toBe(runner.pid);
      expect(kept?.web).toBe(web.pid);
    },
    120_000,
  );

  it.skipIf(!onWindows || !processTable.available)(
    'a partial stop keeps only what is still running on record',
    async () => {
      const runner = spawnIdle();
      const web = spawnIdle();
      // Runner recorded with its identity; web as a bare number.
      await recordServiceTree({ runner: runner.pid!, web: web.pid! });
      const full = readPids()!;
      writeFileSync(
        join(home, 'pids', 'processes.json'),
        JSON.stringify({ ...full, roots: (full.roots ?? []).filter((r) => r.pid === runner.pid) }),
        'utf-8',
      );

      await runDownCaptured();

      expect(await waitForPidDead(runner.pid!, 15_000)).toBe(true);
      expect(isPidAlive(web.pid!)).toBe(true);
      const kept = readPids();
      expect(kept?.runner).toBeUndefined();
      expect(kept?.web).toBe(web.pid);
    },
    120_000,
  );
});
