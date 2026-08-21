// recorded-tree.test.ts — the tree captured at startup, and the sweep that
// uses it later.
//
// The bug this closes (case 3a, external validation 2026-08-21): Ctrl+C left a
// Next server holding :3000, and the next `up` reported it as an orphan. The
// earlier fix snapshotted descendants at kill time, which is too late — Windows
// delivers Ctrl+C to the whole console group at once, so the intermediate
// process is already dying when our handler walks the tree, and a dead parent
// leaves no parent/child edge to follow. The survivor's recorded parent (26256)
// was neither pid we had announced, which is what gave the middle link away.
//
// So the tree is recorded while everything is healthy and swept from that
// record afterwards. The dangerous part of doing it that way is acting on a
// stale pid — Windows recycles pid numbers — and that is what most of these
// cases pin down.
//
// Real processes throughout: the whole point is what the OS actually reports.

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  processSnapshotWin,
  walkDescendants,
  sweepRecordedChildren,
  isPidAlive,
  type ProcessRecord,
} from '../lib/processes.ts';

const onWindows = process.platform === 'win32';

// A PowerShell start-up plus a WMI enumeration runs ~0.5s warm and past 5s on a
// cold CI runner. Budgets are sized for the cold runner.
const WMI_BUDGET_MS = 30_000;

/** Wait until `check()` is true, or give up. */
async function until(check: () => boolean | Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** A process that outlives the test unless killed. Registered for cleanup. */
function spawnIdle(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

describe('processSnapshotWin', () => {
  it.skipIf(!onWindows)(
    'reports a creation tick for a process we just started',
    async () => {
      const child = spawnIdle();
      try {
        const snapshot = await processSnapshotWin();
        const rec = snapshot.get(child.pid!);
        expect(rec, 'the freshly spawned process was not in the snapshot').toBeDefined();
        // The tick is what makes a recorded pid safe to act on later; without
        // it the sweep has no way to tell a survivor from a recycled number.
        expect(rec!.startedAt, 'no creation tick — identity check impossible').toMatch(/^\d+$/);
        expect(rec!.ppid).toBe(process.pid);
      } finally {
        child.kill();
      }
    },
    WMI_BUDGET_MS,
  );

  it.skipIf(onWindows)('is empty off Windows rather than throwing', async () => {
    expect((await processSnapshotWin()).size).toBe(0);
  });
});

describe('walkDescendants', () => {
  // Pure function over a snapshot — no processes needed, so these run
  // everywhere and cost nothing.
  const rec = (pid: number, ppid: number, startedAt = '1'): ProcessRecord => ({
    pid,
    ppid,
    startedAt,
  });
  const asMap = (list: ProcessRecord[]) => new Map(list.map((r) => [r.pid, r]));

  it('follows a chain two levels deep', () => {
    const snap = asMap([rec(10, 1), rec(20, 10), rec(30, 20)]);
    expect(
      walkDescendants(snap, 10)
        .map((r) => r.pid)
        .sort(),
    ).toEqual([20, 30]);
  });

  it('never returns the root — the caller kills that one directly', () => {
    const snap = asMap([rec(10, 1), rec(20, 10)]);
    expect(walkDescendants(snap, 10).map((r) => r.pid)).not.toContain(10);
  });

  it('ignores branches that are not ours', () => {
    const snap = asMap([rec(10, 1), rec(20, 10), rec(99, 1), rec(98, 99)]);
    expect(walkDescendants(snap, 10).map((r) => r.pid)).toEqual([20]);
  });

  it('terminates on a cycle instead of looping forever', () => {
    // A corrupt parent chain must not hang a shutdown.
    const snap = asMap([rec(10, 20), rec(20, 10)]);
    expect(walkDescendants(snap, 10).map((r) => r.pid)).toEqual([20]);
  });
});

describe('sweepRecordedChildren', () => {
  it.skipIf(!onWindows)(
    'kills a recorded process that is still the same process',
    async () => {
      const child = spawnIdle();
      try {
        const snapshot = await processSnapshotWin();
        const rec = snapshot.get(child.pid!);
        expect(rec).toBeDefined();

        const killed = await sweepRecordedChildren([rec!]);
        expect(killed, 'the surviving worker was not swept').toContain(child.pid);
        expect(await until(() => !isPidAlive(child.pid!), 10_000)).toBe(true);
      } finally {
        child.kill();
      }
    },
    WMI_BUDGET_MS,
  );

  it.skipIf(!onWindows)(
    'refuses to kill a live process whose pid was recycled',
    async () => {
      // THE case that makes a recorded list dangerous. A pid recorded minutes
      // ago can name something else entirely by the time we act — and killing
      // it means killing a stranger's work, the same failure the ownership
      // guard in `up` exists to prevent, reached from the other direction.
      //
      // Simulated by recording a real, live pid under a creation tick that does
      // not match: same number, different process, which is exactly what
      // recycling looks like from the sweep's side.
      const bystander = spawnIdle();
      try {
        const snapshot = await processSnapshotWin();
        const real = snapshot.get(bystander.pid!);
        expect(real).toBeDefined();

        const stale: ProcessRecord = { ...real!, startedAt: '1' };
        const killed = await sweepRecordedChildren([stale]);

        expect(killed, 'a recycled pid was killed').not.toContain(bystander.pid);
        expect(isPidAlive(bystander.pid!), 'the bystander process was killed').toBe(true);
      } finally {
        bystander.kill();
      }
    },
    WMI_BUDGET_MS,
  );

  it('does nothing, and never throws, on an empty record', async () => {
    // A pid file written before this feature existed has no `children` key.
    expect(await sweepRecordedChildren([])).toEqual([]);
  });

  it.skipIf(!onWindows)(
    'skips pids that already died without touching anything else',
    async () => {
      const child = spawnIdle();
      const snapshot = await processSnapshotWin();
      const rec = snapshot.get(child.pid!);
      expect(rec).toBeDefined();
      child.kill();
      expect(await until(() => !isPidAlive(child.pid!), 10_000)).toBe(true);

      expect(await sweepRecordedChildren([rec!])).toEqual([]);
    },
    WMI_BUDGET_MS,
  );
});
