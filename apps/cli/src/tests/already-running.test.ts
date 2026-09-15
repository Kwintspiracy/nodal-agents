// already-running.test.ts — `up` refuses to clean up a stack that is running
// (issue #117).
//
// On 2026-09-15 at 21:05 a `pnpm dev` in the repo ran `up` against a healthy
// install. The pre-flight classified the live runner, web and postgres as
// orphans, killed all three, and the turbo run then failed — so nothing
// replaced them. Two and a half hours down.
//
// The decision cases are pure. The probe case is not: it serves a real
// `/api/health` over a real socket on a real port, next to a real
// `postmaster.pid` naming a live process, because that combination is exactly
// what `up` mistook for rubbish.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideStart,
  decideStartFromProbes,
  formatAlreadyRunning,
  type RunningStackEvidence,
} from '../lib/already-running.ts';
import { findFreePort } from '../lib/ports.ts';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A runner that answers /api/health exactly as the real one does. */
async function fakeHealthyRunner(): Promise<number> {
  const port = await findFreePort(24100);
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, db: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return port;
}

/** A runner that is up but sick — the case that must NOT block a restart. */
async function fakeDegradedRunner(): Promise<number> {
  const port = await findFreePort(24200);
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, db: 'error' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return port;
}

/**
 * A data directory whose lockfile names a LIVE postmaster.
 *
 * The pid is this test process: alive, which is the only property
 * `livePostmasterPid` reads. Line 2 is the data dir itself, which
 * `readPostmasterClaim` checks since #98.
 */
function dataDirClaimingLivePostmaster(pid = process.pid): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-running-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'postmaster.pid'),
    `${pid}\n${dir}\n${Math.floor(Date.now() / 1000)}\n`,
    'utf-8',
  );
  return dir;
}

/** A data directory with no lockfile at all — nothing is running here. */
function emptyDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-empty-'));
  dirs.push(dir);
  return dir;
}

describe('decideStart @cap:installer-et-demarrer/moteur', () => {
  const both: RunningStackEvidence = {
    runnerHealthy: true,
    postmasterPid: 41956,
    runnerPid: 3001,
    webPid: 3000,
  };

  it('refuses when the runner is healthy AND the data dir names a live postmaster', () => {
    const v = decideStart(both);
    expect(v.proceed).toBe(false);
    if (v.proceed) return;
    expect(v.reason).toBe('ALREADY_RUNNING');
  });

  it('proceeds on a healthy runner alone', () => {
    // A port says nothing about WHICH install answered. Another Nodal-Agents on
    // the machine, or a stale tunnel, would otherwise stop `up` from ever
    // recovering its own data directory.
    expect(decideStart({ ...both, postmasterPid: null }).proceed).toBe(true);
  });

  it('proceeds on a live postmaster alone — that is the orphan case', () => {
    // A postmaster still holding the shared-memory section after its launcher
    // died is exactly what this pre-flight was built to clean up. Refusing here
    // would break the recovery `up` has done correctly since 2026-08-20.
    expect(decideStart({ ...both, runnerHealthy: false }).proceed).toBe(true);
  });
});

describe('formatAlreadyRunning @cap:installer-et-demarrer/moteur', () => {
  it('names every pid it found, and tells the user what to run', () => {
    const msg = formatAlreadyRunning({
      runnerHealthy: true,
      postmasterPid: 41956,
      runnerPid: 111,
      webPid: 222,
    });
    expect(msg).toContain('runner pid 111');
    expect(msg).toContain('web pid 222');
    expect(msg).toContain('postgres pid 41956');
    expect(msg).toContain('nodal-agents down');
  });

  it('omits a port whose pid was never measured rather than inventing one', () => {
    // Issue #97: a pid printed next to a port nobody measured is a lie that
    // sent thirteen lines of a real incident report to the wrong place.
    const msg = formatAlreadyRunning({
      runnerHealthy: true,
      postmasterPid: 41956,
      runnerPid: null,
      webPid: null,
    });
    expect(msg).not.toContain('runner pid');
    expect(msg).not.toContain('web pid');
    expect(msg).toContain('postgres pid 41956');
  });
});

describe('decideStartFromProbes @cap:installer-et-demarrer/moteur', () => {
  it('refuses against a REAL healthy runner and a REAL live lockfile', async () => {
    // THE 2026-09-15 21:05 case. Both readings are genuine: an HTTP server
    // answering /api/health 200 on a real port, and a postmaster.pid naming a
    // process that is alive. Before #117 `up` called this three orphans.
    const runnerPort = await fakeHealthyRunner();
    const dataDir = dataDirClaimingLivePostmaster();

    const verdict = await decideStartFromProbes({ runnerPort, webPort: runnerPort, dataDir });

    expect(verdict.proceed, 'a healthy running stack was cleared for cleanup').toBe(false);
    if (verdict.proceed) return;
    expect(verdict.message).toContain('already running');
    expect(verdict.message).toContain(`postgres pid ${process.pid}`);
  });

  it('proceeds when the runner answers but is degraded', async () => {
    // A stack whose database is gone is precisely what a restart is for.
    const runnerPort = await fakeDegradedRunner();
    const dataDir = dataDirClaimingLivePostmaster();
    expect(
      (await decideStartFromProbes({ runnerPort, webPort: runnerPort, dataDir })).proceed,
    ).toBe(true);
  });

  it('proceeds when nothing is listening at all', async () => {
    const runnerPort = await findFreePort(24300);
    const dataDir = dataDirClaimingLivePostmaster();
    expect(
      (await decideStartFromProbes({ runnerPort, webPort: runnerPort, dataDir })).proceed,
    ).toBe(true);
  });

  it('never makes an HTTP request when the data dir claims nothing', async () => {
    // The lockfile is a file read and it is conclusive on its own, so a machine
    // with nothing running pays nothing for this guard. Proven by pointing the
    // runner port at a server that would fail the test if it were reached.
    const port = await findFreePort(24400);
    let touched = false;
    const server = createServer((_req, res) => {
      touched = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, db: 'ok' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const verdict = await decideStartFromProbes({
      runnerPort: port,
      webPort: port,
      dataDir: emptyDataDir(),
    });

    expect(verdict.proceed).toBe(true);
    expect(touched, 'the health endpoint was probed for nothing').toBe(false);
  });
});
