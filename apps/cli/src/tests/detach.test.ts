// detach.test.ts — `up --detach` and the tree-kill `down` depends on.
//
// Why this exists: until 2026-08-11 `up` WAS the platform's lifetime. Closing
// the terminal killed the runner, and with it every schedule, the curator and
// the community-skill update watch — crons that are implemented and correct and
// simply never got to run overnight. `--detach` hands the terminal back and
// leaves the services up.
//
// Two things can silently undo that, so both are tested against real processes
// rather than mocks:
//
//   1. Wiring the child's stdout to a PIPE. The read end belongs to the CLI; the
//      moment it exits, the child's next write past the buffer takes EPIPE and
//      the service dies minutes later for no visible reason. Detached must hand
//      the child the log FILE.
//   2. `down` killing only the recorded pid. On Windows that pid is the cmd.exe
//      wrapper in dev layout, so node.exe survives, keeps :3000, and the next
//      `up` fails on a port it was just told was free.

import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { Command } from 'commander';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isPidAlive, killPidTree, spawnWiring, waitForPidDead } from '../lib/processes.ts';

/** execa's real entry point, so the launcher below resolves it from a temp dir. */
const execaEntry = pathToFileURL(createRequire(import.meta.url).resolve('execa')).href;

const spawned: number[] = [];

afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    if (isPidAlive(pid)) await killPidTree(pid);
  }
});

describe('up --detach — the flag reaches the action', () => {
  // Mirrors index.ts's registration exactly (see dev-flag.test.ts for why the
  // program/subcommand duplication is load-bearing): a flag registered on both
  // levels is consumed by the program unless positional options are enabled,
  // and the subcommand then runs with opts={} — silently attached.
  function buildCli() {
    const capture = { up: null as Record<string, unknown> | null };
    const program = new Command();
    program.exitOverride();
    program.enablePositionalOptions();
    program
      .option('--dev', 'program-level dev')
      .option('-d, --detach', 'program-level detach')
      .action(() => {});
    program
      .command('up')
      .option('--dev', 'subcommand dev')
      .option('-d, --detach', 'subcommand detach')
      .action((opts: Record<string, unknown>) => {
        capture.up = opts;
      });
    return { program, capture };
  }

  it('`up --detach` arrives as opts.detach=true', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', 'up', '--detach']);
    expect(capture.up).toEqual({ detach: true });
  });

  it('the short form `-d` does too', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', 'up', '-d']);
    expect(capture.up).toEqual({ detach: true });
  });

  it('`up --dev --detach` carries BOTH — dev is not swallowed', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', 'up', '--dev', '--detach']);
    expect(capture.up).toEqual({ dev: true, detach: true });
  });

  it('plain `up` stays attached — detach is never implied', async () => {
    const { program, capture } = buildCli();
    await program.parseAsync(['node', 'cli.js', 'up']);
    expect(capture.up).toEqual({});
  });
});

describe('detached stdio — the child owns the log file, not a pipe', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // The launcher below has to restate the wiring (it runs as plain .mjs and
  // cannot import a .ts module), so this test pins the two together: if
  // production ever goes back to pipes or drops `detached`, this fails even
  // though the launcher would keep passing.
  it('production wiring is raw descriptors when detached, pipes when not', () => {
    dir = mkdtempSync(join(tmpdir(), 'nodal-detach-'));
    const logFile = join(dir, 'runner.log');

    const attached = spawnWiring(logFile, false);
    expect(attached.stdout).toBe('pipe');
    expect(attached.stderr).toBe('pipe');
    expect(attached.detached).toBe(false);

    // A previous run's log. It must still be there afterwards: `logs` reads this
    // file, and an 'w' open would silently erase the history at every start.
    writeFileSync(logFile, 'from an earlier run\n', 'utf8');

    const detached = spawnWiring(logFile, true);
    expect(detached.detached).toBe(true);
    const stdio = detached.stdio as unknown as unknown[];
    expect(stdio[0]).toBe('ignore');
    // A number, not 'pipe' — the child owns the descriptor. And the SAME
    // descriptor for both streams, so interleaving stays chronological.
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[1]).toBe(stdio[2]);

    // Writing through the descriptor production handed out must APPEND.
    const fd = stdio[1] as number;
    writeSync(fd, 'from this run\n');
    closeSync(fd);
    const contents = readFileSync(logFile, 'utf8');
    expect(contents).toContain('from an earlier run');
    expect(contents).toContain('from this run');
  });

  it('keeps logging AFTER the spawning CLI has exited — the whole point', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nodal-detach-'));
    const logFile = join(dir, 'runner.log');
    const launcher = join(dir, 'launcher.mjs');

    // A stand-in for the CLI: it spawns a service with the exact wiring
    // spawnWiring() produces for detach:true, then exits — like `up --detach`
    // returning you to the prompt. Everything this test asserts happens after
    // that process is dead, which is the only way to catch the failure mode
    // that matters (a parent-mediated pipe: the child then takes EPIPE and
    // dies, and asserting inside a live parent would never see it).
    writeFileSync(
      launcher,
      [
        `import { execa } from ${JSON.stringify(execaEntry)};`,
        'import { openSync } from "node:fs";',
        `const fd = openSync(${JSON.stringify(logFile)}, "a");`,
        'const child = execa(process.execPath, ["-e", process.argv[2]], {',
        '  stdio: ["ignore", fd, fd],',
        '  detached: true, windowsHide: true, reject: false,',
        '});',
        'child.unref();',
        'process.stdout.write(String(child.pid));',
      ].join('\n'),
      'utf8',
    );

    // The service writes one line per tick, so "still alive" is observable.
    const service = 'let n = 0; setInterval(() => process.stdout.write(`tick ${++n}\\n`), 100);';

    const launched = await execa(process.execPath, [launcher, service], { reject: false });
    const servicePid = Number.parseInt(launched.stdout.trim(), 10);
    expect(Number.isInteger(servicePid) && servicePid > 0).toBe(true);
    spawned.push(servicePid);

    // The launcher is gone. Wait for the file to reach a line count that cannot
    // have been produced before it exited.
    const countTicks = (): number => {
      try {
        return (readFileSync(logFile, 'utf8').match(/tick /g) ?? []).length;
      } catch {
        return 0;
      }
    };
    const before = countTicks();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && countTicks() < before + 10) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(isPidAlive(servicePid)).toBe(true);
    expect(countTicks()).toBeGreaterThanOrEqual(before + 10);
  }, 40_000);

  it('append never truncates — a second start keeps the first run’s history', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nodal-detach-'));
    const logFile = join(dir, 'runner.log');

    // openSync with 'a' — the same call spawnWiring makes. 'w' here would erase
    // every previous run's log at each start, which `logs` reads.
    for (const marker of ['first', 'second']) {
      const fd = openSync(logFile, 'a');
      const p = await execa(process.execPath, ['-e', `process.stdout.write("${marker}\\n")`], {
        stdio: ['ignore', fd, fd] as never,
        reject: false,
      });
      closeSync(fd);
      expect(p.exitCode).toBe(0);
    }

    const contents = readFileSync(logFile, 'utf8');
    expect(contents).toContain('first');
    expect(contents).toContain('second');
  });
});

/**
 * What this block proves, and what it does NOT.
 *
 * PROVES: after `killPidTree(pid)`, neither the named process nor the process
 * it spawned is alive, and calling it on an already-dead pid is a no-op. That
 * is the contract `down` needs — it holds a bare number from processes.json and
 * must leave nothing behind on the port.
 *
 * DOES NOT prove that `taskkill`'s `/T` is what achieves it. Measured on
 * 2026-08-11: killing a node→node parent with `/F` alone already takes the
 * child down, because libuv puts spawned processes in a Win32 job object that
 * cascades. So this suite cannot distinguish `/T` from its absence, and the
 * mutation that removes the flag stays green — said here rather than left for
 * someone to rediscover. `/T` is kept for the layer the job object does not
 * cover: the dev layout's `shell:true` spawn goes through cmd.exe, which is the
 * documented case where node.exe survived and kept the port (see
 * killProcessTree's comment).
 */
describe('killPidTree — down must reach the grandchild', () => {
  it('kills a child AND the grandchild it spawned', async () => {
    // The shape `down` actually faces: the recorded pid is a wrapper, the real
    // server is its child. Killing only the wrapper leaves the port held.
    const parentScript =
      'const {spawn}=require("child_process");' +
      `const c=spawn(process.execPath,["-e",'setInterval(()=>{},1000)']);` +
      'process.stdout.write(String(c.pid));' +
      'setInterval(()=>{},1000);';

    const parent = execa(process.execPath, ['-e', parentScript], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
      reject: false,
    });
    spawned.push(parent.pid!);

    const childPid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('grandchild pid never printed')), 10_000);
      parent.stdout?.on('data', (b: Buffer) => {
        const n = Number.parseInt(b.toString().trim(), 10);
        if (Number.isInteger(n) && n > 0) {
          clearTimeout(t);
          resolve(n);
        }
      });
    });
    spawned.push(childPid);

    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    await killPidTree(parent.pid!);

    // Both, not just the one we named. This is the assertion the old
    // `process.kill(pid,'SIGTERM')` in down.ts could not have passed on Windows.
    expect(await waitForPidDead(parent.pid!, 10_000)).toBe(true);
    expect(await waitForPidDead(childPid, 10_000)).toBe(true);
  }, 40_000);

  it('is a no-op on a pid that is already gone', async () => {
    const p = await execa(process.execPath, ['-e', '0'], { reject: false });
    const pid = p.pid!;
    expect(await waitForPidDead(pid, 5_000)).toBe(true);
    await expect(killPidTree(pid)).resolves.toBeUndefined();
  }, 20_000);
});
