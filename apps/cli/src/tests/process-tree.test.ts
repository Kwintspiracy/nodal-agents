// process-tree.test.ts — the descendant snapshot behind a clean shutdown.
//
// Why it exists: `taskkill /T` walks the process tree at the moment it runs,
// which is not always enough. `next dev` spawns Turbopack workers, and a worker
// whose parent is already gone is no longer in any tree taskkill can see. It
// survives, keeps :3000 held, and the next `up` reports it as an orphan —
// reproduced on 2026-08-21 by interrupting `up` during the health wait.
//
// The fix snapshots descendants BEFORE killing, because once the parent dies the
// parent/child link dies with it. These tests pin that snapshot against real
// processes: no mocks, since the whole point is what the OS actually reports.

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { descendantPidsWin } from '../lib/processes.ts';

const onWindows = process.platform === 'win32';

/** Wait until `check()` is true, or give up. Avoids a fixed sleep. */
async function until(check: () => boolean | Promise<boolean>, budgetMs = 8000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe('descendantPidsWin', () => {
  it.skipIf(!onWindows)('returns [] for a PID that has no children', async () => {
    // The test runner itself may have children, so use a PID that cannot:
    // one that does not exist at all.
    expect(await descendantPidsWin(2_147_483_646)).toEqual([]);
  });

  it.skipIf(onWindows)('returns [] off Windows rather than throwing', async () => {
    expect(await descendantPidsWin(process.pid)).toEqual([]);
  });

  it.skipIf(!onWindows)(
    'finds a grandchild that a dying parent would strand',
    async () => {
      // node → node → node. The middle one stands in for the .CMD launcher
      // `spawnWeb` goes through; the deepest one stands in for the Turbopack
      // worker that holds :3000 and survives its parent.
      //
      // Deliberately NOT `cmd.exe /c node -e "…"`: the quotes are re-parsed by
      // cmd and the child dies instantly, which makes the test pass or fail for
      // reasons that have nothing to do with the tree walk (learned by
      // measuring — the first version of this test found nothing because the
      // process it was looking for had never started).
      const grandchild = 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});setTimeout(()=>{},60000)';
      let child: ChildProcess | null = null;
      try {
        child = spawn(process.execPath, ['-e', grandchild], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const rootPid = child.pid;
        expect(rootPid, 'spawn returned no pid').toBeDefined();

        // Two levels deep, so wait for 2 — that is the case taskkill can miss.
        const found = await until(async () => (await descendantPidsWin(rootPid!)).length >= 2);
        expect(found, 'the grandchild was never reported').toBe(true);

        const descendants = await descendantPidsWin(rootPid!);
        expect(descendants.length).toBeGreaterThanOrEqual(2);
        // Never reports the root itself: the caller kills that one directly.
        expect(descendants).not.toContain(rootPid);
      } finally {
        child?.kill();
      }
    },
    20_000,
  );

  it.skipIf(!onWindows)('never returns the root, even when it has children', async () => {
    const descendants = await descendantPidsWin(process.pid);
    expect(descendants).not.toContain(process.pid);
  });
});
