// vitest-worker-exit.test.ts — a vitest worker that dies says how (#841).
//
// On CI Windows, workers died six times on 2026-10-22 with nothing but vitest's
// `Worker exited unexpectedly`: no exit code, no signal, no name for the file
// that went missing from the results. The shared config (vitest.base.ts) now
// runs every package on a forks pool that writes that line, and, when CI asks
// for it, a report file per package (vitest-run-report.ts).
//
// The proof goes through a REAL vitest run, in a subprocess, on the SHARED
// config (fixtures/worker-exit/vitest.config.ts merges vitest.base.ts and adds
// nothing but its `include`): what holds there holds for every package. The
// fixture's worker is killed while it runs (`process.kill(process.pid,
// 'SIGKILL')`: TerminateProcess on Windows, a real SIGKILL on Unix).
//
// Two ways to die, because vitest learns of a death two ways (#970): `dies`
// is mostly noticed through the child's `exit`; `dies-mid-reply` is killed
// with replies from vitest in flight, so most runs see a reply fail first
// (`write EPIPE`, `Channel closed`) and vitest stops the worker BEFORE its
// `exit` arrives. That order is the machine's, never the test's: the last
// describe drives the pool with a fake child, in each order, on purpose.

import { describe, it, expect, vi } from 'vitest';
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { RunReport } from '../vitest-run-report.ts';
import { describeWorkerExit, exitReportingForks } from '../vitest-worker-exit.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'worker-exit');
const VITEST_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const LINE = /\[vitest-worker-exit\] pid=(\d+) code=(\S+) signal=(\S+) files=(.+)/;

const DYING = ['dies', 'dies-mid-reply'] as const;

function runFixture(
  which: (typeof DYING)[number] | 'lives',
  reportDir?: string,
): { status: number | null; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'worker-exit-scratch-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKER_EXIT_FIXTURE: which,
    WORKER_EXIT_SCRATCH: scratch,
    NO_COLOR: '1',
  };
  delete env['NODAL_VITEST_REPORT_DIR'];
  if (reportDir !== undefined) env['NODAL_VITEST_REPORT_DIR'] = reportDir;
  try {
    const run = spawnSync(
      process.execPath,
      [VITEST_BIN, 'run', '--root', FIXTURE, '--config', join(FIXTURE, 'vitest.config.ts')],
      { cwd: FIXTURE, env, encoding: 'utf-8', timeout: 50_000 },
    );
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('a vitest worker that dies on its own says how', () => {
  it.each(DYING)('%s: names the exit code, the signal and the file it was running', (which) => {
    const { status, output } = runFixture(which);
    // vitest's own cause is `Worker exited unexpectedly`, `write EPIPE` or
    // `Channel closed`, depending on which sign of the death reached it first.
    expect(output).toMatch(/Worker .* emitted error/);
    const m = LINE.exec(output);
    expect(m, output).not.toBeNull();
    const [, pid, code, signal, files] = m!;
    expect(Number(pid)).toBeGreaterThan(0);
    expect(files?.trim()).toBe(`${which}.fixture.ts`);
    if (process.platform === 'win32') {
      // TerminateProcess with exit code 1: what `taskkill /F` also leaves.
      expect([code, signal]).toEqual(['1', 'null']);
    } else {
      expect([code, signal]).toEqual(['null', 'SIGKILL']);
    }
    expect(status).toBe(1);
  });

  it('says nothing for the workers vitest stops itself', () => {
    const { status, output } = runFixture('lives');
    expect(output).toMatch(/Tests\s+1 passed/);
    expect(output).not.toContain('[vitest-worker-exit]');
    expect(status).toBe(0);
  });

  // The fixture runs from its own directory, as turbo runs each package.
  const NAME = 'packages__test-kit__src__tests__fixtures__worker-exit';

  it.each(DYING)(
    '%s: with a report directory, the file of the dead worker is reported unfinished, never passed',
    (which) => {
      const dir = mkdtempSync(join(tmpdir(), 'vitest-report-'));
      try {
        const { status, output } = runFixture(which, dir);
        expect(status, output).toBe(1);
        const exits = readFileSync(join(dir, `${NAME}.worker-exits.log`), 'utf8');
        // The file holds the very line stderr got, and only that one.
        expect(exits.trimEnd().split('\n')).toEqual([LINE.exec(output)?.[0]]);
        expect(exits).toContain(`files=${which}.fixture.ts`);
        const report = JSON.parse(
          readFileSync(join(dir, `${NAME}.vitest-report.json`), 'utf8'),
        ) as RunReport;
        expect(report.package).toBe(NAME);
        expect(report.unfinished).toEqual([`${which}.fixture.ts`]);
        expect(report.files.map((f) => [f.file, f.state, f.tests])).toEqual([
          [`${which}.fixture.ts`, 'pending', { pending: 1 }],
        ]);
        expect(report.unhandledErrors.join('\n')).toMatch(/Worker .* emitted error/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('with a report directory, a green run is reported finished and passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-report-'));
    try {
      const { status, output } = runFixture('lives', dir);
      expect(status, output).toBe(0);
      const report = JSON.parse(
        readFileSync(join(dir, `${NAME}.vitest-report.json`), 'utf8'),
      ) as RunReport;
      expect(report.unfinished).toEqual([]);
      expect(report.unhandledErrors).toEqual([]);
      expect(report.files.map((f) => [f.file, f.state, f.tests])).toEqual([
        ['lives.fixture.ts', 'passed', { passed: 1 }],
      ]);
      expect(existsSync(join(dir, `${NAME}.worker-exits.log`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without one, writes no file', () => {
    const before = readdirSync(FIXTURE).sort();
    const { status } = runFixture('dies');
    expect(status).toBe(1);
    expect(readdirSync(FIXTURE).sort()).toEqual(before);
  });
});

describe('describeWorkerExit', () => {
  it('spells a Windows status in hex, next to its decimal value', () => {
    expect(
      describeWorkerExit({ pid: 7, code: 3221225477, signal: null, files: ['a.test.ts'] }),
    ).toBe('[vitest-worker-exit] pid=7 code=3221225477 (0xC0000005) signal=null files=a.test.ts');
  });

  it('says when the worker had not been given a file yet', () => {
    expect(describeWorkerExit({ pid: undefined, code: null, signal: 'SIGKILL', files: [] })).toBe(
      '[vitest-worker-exit] pid=undefined code=null signal=SIGKILL files=(none sent yet)',
    );
  });
});

// A child process whose events the test emits itself, in the order it chooses.
// `die()` is the death; what the parent hears of it comes after, one sign at a
// time, as on a real machine where the pipe, the failed write and the exit
// status each arrive on their own.
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = null;
  readonly stderr = null;
  exitCode: number | null = null;
  connected = true;
  private dead = false;

  die(): void {
    this.dead = true;
  }

  exit(code: number): void {
    this.dead = true;
    this.connected = false;
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  /** As node's: a live child is terminated (exit code 1, as on Windows); a dead
   * one is not, and `kill` says so. */
  kill(): boolean {
    if (this.dead) return false;
    this.dead = true;
    setImmediate(() => this.exit(1));
    return true;
  }

  send(): boolean {
    return true;
  }
}

// The death signs vitest can react to, each followed by the exit status.
const SIGNS = {
  exit: (c: FakeChild) => c.exit(1),
  'write error': (c: FakeChild) => {
    c.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    c.exit(1);
  },
  disconnect: (c: FakeChild) => {
    c.connected = false;
    c.emit('disconnect');
    c.exit(1);
  },
} as const;
type Sign = keyof typeof SIGNS;
const FIRST_EVENT: Record<Sign, string> = {
  exit: 'exit',
  'write error': 'error',
  disconnect: 'disconnect',
};

describe('the pool decides "unexpected" whatever the order of the exit listeners (#970)', () => {
  const ROOT = join(tmpdir(), 'worker-exit-root');

  /** Runs `scenario` on the pool's worker, wired to a fake child; returns what
   * the pool wrote, on stderr and in its log file. */
  async function drive(
    scenario: (worker: PoolWorker, child: FakeChild) => Promise<void>,
  ): Promise<{ stderr: string[]; logFile: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'worker-exit-order-'));
    const logFile = join(dir, 'exits.log');
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk).trimEnd());
      return true;
    });
    try {
      const options = {
        execArgv: [],
        env: {},
        distPath: dir,
        project: {
          config: { root: ROOT },
          vitest: { logger: { outputStream: new PassThrough(), errorStream: new PassThrough() } },
        },
      } as unknown as PoolOptions;
      const worker = exitReportingForks({ logFile }).createPoolWorker(options);
      const child = new FakeChild();
      // vitest's `start()` keeps a child it already has (`this._fork ||= fork(…)`).
      (worker as unknown as { _fork: FakeChild })._fork = child;
      await scenario(worker, child);
    } finally {
      spy.mockRestore();
    }
    try {
      const written = existsSync(logFile)
        ? readFileSync(logFile, 'utf8').trimEnd().split('\n')
        : [];
      return { stderr, logFile: written };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const RUN = {
    type: 'run',
    context: { files: [{ filepath: join(ROOT, 'src', 'a.test.ts') }] },
  } as unknown as WorkerRequest;
  const DEAD_LINE = `[vitest-worker-exit] pid=4242 code=1 signal=null files=${join('src', 'a.test.ts')}`;

  const CASES = (Object.keys(SIGNS) as Sign[]).flatMap((sign) =>
    (['before', 'after'] as const).map((order) => ({ sign, order })),
  );

  it.each(CASES)(
    'a child lost by $sign, with a listener registered $order ours that stops the worker on the spot: reported',
    async ({ sign, order }) => {
      const out = await drive(async (worker, child) => {
        let stopped: Promise<void> | undefined;
        const stopNow = (): void => {
          stopped ??= worker.stop();
        };
        if (order === 'before') child.on(FIRST_EVENT[sign], stopNow);
        await worker.start();
        if (order === 'after') worker.on(FIRST_EVENT[sign], stopNow);
        worker.send(RUN);
        child.die();
        SIGNS[sign](child);
        await stopped;
      });
      expect(out.stderr).toEqual([DEAD_LINE]);
      expect(out.logFile).toEqual(out.stderr);
    },
  );

  // vitest's own worker, once it has answered `stopped`, drops its `message`
  // listeners and leaves on its own with code 0, often before the pool gets to
  // `stop()` (seen in CI Windows run 41659236343: `code=0` on a green run).
  it.each([
    {
      signs: 'disconnect, then exit 0',
      lose: (c: FakeChild) => {
        c.connected = false;
        c.emit('disconnect');
        c.exit(0);
      },
    },
    { signs: 'exit 0 alone', lose: (c: FakeChild) => c.exit(0) },
  ])(
    'a child asked to stop that leaves on its own before stop() ($signs): nothing is written',
    async ({ lose }) => {
      const out = await drive(async (worker, child) => {
        await worker.start();
        worker.send(RUN);
        worker.send({ type: 'stop' } as unknown as WorkerRequest);
        child.die();
        lose(child);
        await worker.stop();
      });
      expect(out).toEqual({ stderr: [], logFile: [] });
    },
  );

  it('a child vitest stops while it lives: nothing is written, even when the stop is answered by a write error', async () => {
    const out = await drive(async (worker, child) => {
      await worker.start();
      worker.on('error', () => {}); // vitest's pool listens, as PoolRunner does
      worker.send(RUN);
      const stopped = worker.stop();
      child.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await stopped;
      expect(child.exitCode).toBe(1);
    });
    expect(out).toEqual({ stderr: [], logFile: [] });
  });
});
