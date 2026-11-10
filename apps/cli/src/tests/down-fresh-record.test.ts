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

import { describe, it, expect, afterEach, afterAll, vi, type TestContext } from 'vitest';

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
  lastSnapshotFailure,
  readPids,
  recordServiceTree,
  waitForPidDead,
  type PidFile,
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

/**
 * Skip THIS case, out loud, when the machine did not answer a reading the case
 * depends on.
 *
 * What `down` needs from the machine is one thing: its own reading of the
 * table, taken once before it signals anything (#1046). The probe at load asks
 * that same question the same way; a loaded runner can still answer the probe
 * and not answer `down` a minute later. That is a fact about the machine, said
 * and skipped. Anything else — a pid refused or left running although `down`'s
 * reading DID answer — is the product, and fails the case.
 */
function skipUnanswered(ctx: TestContext, what: string): never {
  const why = `${what} (${lastSnapshotFailure ?? 'no reason reported'})`;
  console.warn(`\n[tests] SKIPPING this down-fresh-record case: ${why}\n`);
  ctx.skip(why);
}

/** The spawn-time record, skipped out loud when its reading did not answer. */
async function recordOrSkip(ctx: TestContext, pids: PidFile): Promise<void> {
  const outcome = await recordServiceTree(pids);
  if (outcome.unidentified.length > 0) {
    skipUnanswered(
      ctx,
      `the reading that records the spawn did not identify ${outcome.unidentified.join(', ')}`,
    );
  }
}

/** Run `down` with its console and stderr captured, so a refusal can be read. */
async function runDownCaptured(
  ctx: TestContext,
  pids: readonly number[],
): Promise<{ stderr: string }> {
  const said: string[] = [];
  const printed: string[] = [];
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    said.push(String(chunk));
    return true;
  }) as never);
  const out = vi.spyOn(console, 'log').mockImplementation(((line: unknown) => {
    printed.push(String(line));
  }) as never);
  try {
    await runDown();
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
  // `down`'s own reading did not answer: it refused every pid BEFORE any kill,
  // with this exact line. A refusal from anywhere else does not match it.
  const text = printed.join('\n');
  const unanswered = pids.some((pid) =>
    text.includes(
      `(pid ${pid}) was NOT stopped — pid ${pid} could not be confirmed: the process table did not answer`,
    ),
  );
  if (unanswered) skipUnanswered(ctx, "down's own reading of the process table did not answer");
  return { stderr: said.join('') };
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    // Through its handle, never by number (#841): a stand-in is a lone process,
    // and `child.kill` does nothing once it has exited (killed by `down`, say),
    // when its pid may already belong to a stranger.
    child.kill('SIGKILL');
  }
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('down after a fresh start @cap:installer-et-demarrer/moteur', () => {
  it.skipIf(!canRun)(
    'stops runner and web recorded at the spawn, before any health check',
    async (ctx) => {
      const runner = spawnIdle();
      const web = spawnIdle();
      // What `up` does right after spawning the two services — nothing else has
      // happened yet: no health check, no render check.
      // Off Windows there is no table and nothing to identify: nothing to skip.
      if (onWindows) await recordOrSkip(ctx, { runner: runner.pid!, web: web.pid! });
      else await recordServiceTree({ runner: runner.pid!, web: web.pid! });
      expect(isPidAlive(runner.pid!)).toBe(true);
      expect(isPidAlive(web.pid!)).toBe(true);

      await runDownCaptured(ctx, [runner.pid!, web.pid!]);

      expect(await waitForPidDead(runner.pid!, 15_000)).toBe(true);
      expect(await waitForPidDead(web.pid!, 15_000)).toBe(true);
      // Everything stopped: nothing is kept on record.
      expect(readPids()).toEqual({});
    },
    120_000,
  );

  it.skipIf(!onWindows || !processTable.available)(
    'a record of bare numbers is still refused: nothing is signalled and the record is kept',
    async (ctx) => {
      const runner = spawnIdle();
      const web = spawnIdle();
      // The shape 0.9.7 could leave behind: pids, no identity.
      writeFileSync(
        join(home, 'pids', 'processes.json'),
        JSON.stringify({ runner: runner.pid, web: web.pid }),
        'utf-8',
      );

      const { stderr } = await runDownCaptured(ctx, [runner.pid!, web.pid!]);

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
    async (ctx) => {
      const runner = spawnIdle();
      const web = spawnIdle();
      // Runner recorded with its identity; web as a bare number.
      await recordOrSkip(ctx, { runner: runner.pid!, web: web.pid! });
      const full = readPids()!;
      writeFileSync(
        join(home, 'pids', 'processes.json'),
        JSON.stringify({ ...full, roots: (full.roots ?? []).filter((r) => r.pid === runner.pid) }),
        'utf-8',
      );

      await runDownCaptured(ctx, [runner.pid!, web.pid!]);

      expect(await waitForPidDead(runner.pid!, 15_000)).toBe(true);
      expect(isPidAlive(web.pid!)).toBe(true);
      const kept = readPids();
      expect(kept?.runner).toBeUndefined();
      expect(kept?.web).toBe(web.pid);
    },
    120_000,
  );
});
