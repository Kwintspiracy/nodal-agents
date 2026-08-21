// postmaster-pid.test.ts — regression for the orphan-Postgres DETECTION fix.
//
// `up` used to look for orphans by LISTENING PORT only. The orphan that
// actually hurts holds no port: a postmaster that died during startup, or is
// stuck mid-shutdown, has no socket left while its Win32 shared-memory section
// — keyed to the DATA DIR, not the port — is still attached. A port scan
// reports every port free, `up` sails past its pre-flight, and Postgres then
// dies on the opaque FATAL "pre-existing shared memory block is still in use"
// (live machine, 2026-08-20; a reboot did not clear it).
//
// These tests pin the data-dir probe that closes that blind spot, against real
// files and real PIDs — no mocks: the whole point is that the probe reads what
// Postgres actually writes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPostmasterPid, livePostmasterPid } from '../lib/postgres.ts';

// PIDs this high aren't allocated on Windows or Linux in practice, so
// kill(pid, 0) throws ESRCH.
const DEAD_PID = 2_147_483_646;

let dataDir: string;

/**
 * Write a lockfile in the real shape Postgres uses: the PID on the first line,
 * then the data dir, the start timestamp, the port, and so on. The probe must
 * read the first line and ignore the rest.
 */
function writePostmasterPid(pid: number): void {
  writeFileSync(
    join(dataDir, 'postmaster.pid'),
    `${pid}\n${dataDir}\n1755600000\n25432\n/tmp\nlocalhost\n  5432001         0\nready   \n`,
    'utf-8',
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nodalai-pgdata-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('readPostmasterPid', () => {
  it('returns null when there is no lockfile', () => {
    expect(readPostmasterPid(dataDir)).toBeNull();
  });

  it('reads the PID from the first line of a real-shaped lockfile', () => {
    writePostmasterPid(31415);
    expect(readPostmasterPid(dataDir)).toBe(31415);
  });

  it('returns null on a corrupt lockfile rather than guessing', () => {
    writeFileSync(join(dataDir, 'postmaster.pid'), 'not-a-pid\n/tmp\n', 'utf-8');
    expect(readPostmasterPid(dataDir)).toBeNull();
  });

  it('returns null on a non-positive PID', () => {
    writePostmasterPid(0);
    expect(readPostmasterPid(dataDir)).toBeNull();
  });
});

describe('livePostmasterPid', () => {
  it('returns null when there is no lockfile', () => {
    expect(livePostmasterPid(dataDir)).toBeNull();
  });

  it('returns null when the recorded PID is dead — that is a STALE lockfile', () => {
    writePostmasterPid(DEAD_PID);
    // The lockfile is readable...
    expect(readPostmasterPid(dataDir)).toBe(DEAD_PID);
    // ...but nothing is running, so there is no orphan to clean up.
    expect(livePostmasterPid(dataDir)).toBeNull();
  });

  it('reports a LIVE recorded PID — the orphan a port scan cannot see', () => {
    // This is the whole fix. The current process is alive and listening on
    // nothing at all, which is precisely the shape of the orphan postmaster
    // that made `up` fail: detectable by data dir, invisible by port.
    writePostmasterPid(process.pid);
    expect(livePostmasterPid(dataDir)).toBe(process.pid);
  });
});
