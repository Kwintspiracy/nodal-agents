// vitest-worker-exit.ts — the forks pool every vitest run of this monorepo uses,
// with one addition: a worker that dies on its own SAYS how (#841).
//
// Vitest's own message for a dead worker is `[vitest-pool]: Worker forks
// emitted error` / `Caused by: Error: Worker exited unexpectedly`, and nothing
// else: its `exit` listener drops the exit code and the signal, and the file the
// worker was running is never named — it is simply missing from the results.
// On CI Windows that happened six times on 2026-10-22, in four packages, and
// each time the log could not tell a kill from a crash from an out-of-memory.
//
// This pool is vitest's `ForksPoolWorker`, unchanged, plus a line on stderr
// when the child exits without vitest having asked it to:
//
//   [vitest-worker-exit] pid=4312 code=1 signal=null files=src/tests/a.test.ts
//
// What the code reads as, on Windows: 1 is `taskkill /F` or `process.kill`
// (TerminateProcess), 3221225477 (0xC0000005) an access violation in native
// code, 3221226505 (0xC0000409) a fail-fast abort (V8's out-of-memory
// included), 134 an abort on Unix; a signal is only ever set on Unix.

import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { ForksPoolWorker } from 'vitest/node';
import type { PoolOptions, PoolRunnerInitializer, PoolWorker, WorkerRequest } from 'vitest/node';

/** The pool's name, as `test.pool` resolves it. It must differ from `forks`:
 * vitest serves its built-in names before it looks at a custom pool. */
export const EXIT_REPORTING_POOL = 'forks-exit-reported';

export interface WorkerExit {
  pid: number | undefined;
  code: number | null;
  signal: string | null;
  /** The files the worker was last asked to run, relative to the project root. */
  files: readonly string[];
}

/** The line written for a worker that died on its own. */
export function describeWorkerExit(e: WorkerExit): string {
  const code =
    e.code !== null && e.code > 255
      ? `${e.code} (0x${e.code.toString(16).toUpperCase()})`
      : String(e.code);
  const files = e.files.length > 0 ? e.files.join(', ') : '(none sent yet)';
  return `[vitest-worker-exit] pid=${String(e.pid)} code=${code} signal=${String(e.signal)} files=${files}`;
}

type Report = (line: string) => void;

export interface ExitReportingOptions {
  /** Also append each line to this file (CI uploads it with the job). */
  logFile?: string;
}

// WHO DECIDES "UNEXPECTED" (#970). The exit is vitest's own when its `stop()`
// reached a child that was still there; it is unexpected when the child was
// LOST first. The `exit` event is not the moment of death: a reply vitest
// sends to a child that has just died fails (`write EPIPE`, or `Channel
// closed` once the pipe is down), the child emits `error`, and vitest's pool
// answers that error with `stop()`, all before the `exit` event arrives
// (measured on Windows: 16 of 36 runs of the `dies-mid-reply` fixture, a
// worker killed with replies in flight). A flag set by `stop()` and read at
// `exit` then took vitest's cleanup for a stop it had asked for, and the line
// was dropped.
//
// So the child is lost at the FIRST of its signs, `error`, `disconnect` or
// `exit`, and the listeners that record it are PREPENDED to the child's own:
// they run before any other listener of the same event, whoever registered
// first, so a listener that calls `stop()` synchronously still finds the child
// marked lost.
const LOST_SIGNS = ['error', 'disconnect', 'exit'] as const;

type Child = Pick<ChildProcess, 'pid' | 'prependListener'>;

class ExitReportingForksWorker extends ForksPoolWorker {
  override readonly name = EXIT_REPORTING_POOL;
  private lost = false;
  private stoppedByVitest = false;
  private files: readonly string[] = [];

  constructor(
    options: PoolOptions,
    private readonly root: string,
    private readonly report: Report,
  ) {
    super(options);
  }

  override send(message: WorkerRequest): void {
    if (message.type === 'run' || message.type === 'collect') {
      this.files = message.context.files.map((f) => relative(this.root, f.filepath));
    }
    super.send(message);
  }

  override async start(): Promise<void> {
    await super.start();
    // `_fork` is private to vitest's class. Without it, nothing here could tell
    // a lost child from a stopped one: a vitest that renames it fails the run.
    const child = (this as unknown as { _fork?: Child })._fork;
    if (child === undefined) {
      throw new Error(
        `[vitest-worker-exit] vitest's ForksPoolWorker has no _fork after start(): ` +
          `this pool cannot tell a dead worker from a stopped one on this vitest version`,
      );
    }
    const pid = child.pid;
    const markLost = (): void => {
      this.lost = true;
    };
    for (const sign of LOST_SIGNS) child.prependListener(sign, markLost);
    this.on('exit', (code: number | null, signal?: string | null) => {
      if (this.stoppedByVitest) return;
      this.report(describeWorkerExit({ pid, code, signal: signal ?? null, files: this.files }));
    });
  }

  override async stop(): Promise<void> {
    if (!this.lost) this.stoppedByVitest = true;
    await super.stop();
  }
}

/** The pool, for `test.pool`. The line goes to stderr, where vitest's own
 * `Worker exited unexpectedly` lands, and to `logFile` when one is given. */
export function exitReportingForks(opts: ExitReportingOptions = {}): PoolRunnerInitializer {
  const report: Report = (line) => {
    process.stderr.write(`${line}\n`);
    if (opts.logFile !== undefined) {
      mkdirSync(dirname(opts.logFile), { recursive: true });
      appendFileSync(opts.logFile, `${line}\n`);
    }
  };
  return {
    name: EXIT_REPORTING_POOL,
    createPoolWorker: (options: PoolOptions): PoolWorker =>
      new ExitReportingForksWorker(options, options.project.config.root, report),
  };
}
