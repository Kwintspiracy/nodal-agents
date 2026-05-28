// pid-liveness.test.ts — regression for the orphan-Postgres cleanup fix.
// Before this, `up` would rotate the Postgres port while an orphan postmaster
// was still alive holding the SHM segment (keyed to the data dir, not the
// port), so the rotated start died with the misleading FATAL "pre-existing
// shared memory block is still in use". The fix verifies the orphan PID is
// actually dead (or aborts loudly). These primitives back that verification.

import { describe, it, expect } from 'vitest';
import { isPidAlive, waitForPidDead } from '../lib/processes.ts';

// A PID that is essentially guaranteed not to exist. PIDs this high aren't
// allocated on Windows or Linux in practice, so kill(pid, 0) throws ESRCH.
const DEAD_PID = 2_147_483_646;

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });
});

describe('waitForPidDead', () => {
  it('resolves true immediately when the PID is already dead', async () => {
    const start = Date.now();
    await expect(waitForPidDead(DEAD_PID, 5000)).resolves.toBe(true);
    // Should short-circuit on the first probe, well under the timeout.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves false after the timeout when the PID stays alive', async () => {
    // The current process never dies during the test — waitForPidDead must
    // poll until the (short) deadline and report it never died.
    await expect(waitForPidDead(process.pid, 500)).resolves.toBe(false);
  });
});
