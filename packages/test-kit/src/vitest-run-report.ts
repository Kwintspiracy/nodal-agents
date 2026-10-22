// vitest-run-report.ts — one package's test results, written to a file that the
// CI job uploads (#841).
//
// Why not vitest's JUnit or JSON reporter: both record the file of a worker that
// died as a PASS. Measured on the fixture of vitest-worker-exit.test.ts (vitest
// 4.1.6): JUnit writes `failures="0" errors="0"` for it, JSON writes
// `"success": true` and `"status": "passed"`. An artifact that calls the missing
// file green is worse than no artifact.
//
// This one writes what vitest itself knows at the end of the run: each file's
// state (`pending` or `queued` for a file whose results never came back), the
// count of its tests per state, and the unhandled errors (vitest's own `Worker
// exited unexpectedly` among them). `unfinished` lists the files that are
// neither passed, failed nor skipped: those are the ones to look for in the
// worker-exit lines.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Reporter, SerializedError, TestModule, TestRunEndReason } from 'vitest/node';

const FINISHED: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped']);

export interface RunReport {
  package: string;
  reason: TestRunEndReason;
  unhandledErrors: string[];
  unfinished: string[];
  files: {
    file: string;
    state: string;
    durationMs: number;
    tests: Record<string, number>;
  }[];
}

export function runReport(
  name: string,
  modules: readonly TestModule[],
  unhandledErrors: readonly SerializedError[],
  reason: TestRunEndReason,
): RunReport {
  const files = modules.map((m) => {
    const tests: Record<string, number> = {};
    for (const t of m.children.allTests()) {
      const state = t.result().state;
      tests[state] = (tests[state] ?? 0) + 1;
    }
    return {
      file: m.relativeModuleId,
      state: m.state(),
      durationMs: Math.round(m.diagnostic().duration),
      tests,
    };
  });
  return {
    package: name,
    reason,
    unhandledErrors: unhandledErrors.map((e) =>
      [e.name, e.message].filter((s) => s !== undefined && s !== '').join(': '),
    ),
    unfinished: files.filter((f) => !FINISHED.has(f.state)).map((f) => f.file),
    files,
  };
}

/** Writes `file` at the end of the run, whatever its outcome. */
export class RunReportReporter implements Reporter {
  constructor(
    private readonly name: string,
    private readonly file: string,
  ) {}

  onTestRunEnd(
    modules: readonly TestModule[],
    unhandledErrors: readonly SerializedError[],
    reason: TestRunEndReason,
  ): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      `${JSON.stringify(runReport(this.name, modules, unhandledErrors, reason), null, 2)}\n`,
    );
  }
}
