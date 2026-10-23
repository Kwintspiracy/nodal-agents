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

class ExitReportingForksWorker extends ForksPoolWorker {
  override readonly name = EXIT_REPORTING_POOL;
  private stopping = false;
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
    // `_fork` is private to vitest's class; its pid is read for the line only,
    // and a vitest that renames the field prints `pid=undefined`, nothing worse.
    const pid = (this as unknown as { _fork?: { pid?: number } })._fork?.pid;
    this.on('exit', (code: number | null, signal?: string | null) => {
      if (this.stopping) return;
      this.report(describeWorkerExit({ pid, code, signal: signal ?? null, files: this.files }));
    });
  }

  override async stop(): Promise<void> {
    this.stopping = true;
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
