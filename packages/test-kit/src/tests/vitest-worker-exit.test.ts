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

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunReport } from '../vitest-run-report.ts';
import { describeWorkerExit } from '../vitest-worker-exit.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'worker-exit');
const VITEST_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const LINE = /\[vitest-worker-exit\] pid=(\d+) code=(\S+) signal=(\S+) files=(.+)/;

function runFixture(
  which: 'dies' | 'lives',
  reportDir?: string,
): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKER_EXIT_FIXTURE: which, NO_COLOR: '1' };
  delete env['NODAL_VITEST_REPORT_DIR'];
  if (reportDir !== undefined) env['NODAL_VITEST_REPORT_DIR'] = reportDir;
  const run = spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', '--root', FIXTURE, '--config', join(FIXTURE, 'vitest.config.ts')],
    { cwd: FIXTURE, env, encoding: 'utf-8', timeout: 50_000 },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('a vitest worker that dies on its own says how', () => {
  it('names the exit code, the signal and the file it was running', () => {
    const { status, output } = runFixture('dies');
    expect(output).toContain('Worker exited unexpectedly');
    const m = LINE.exec(output);
    expect(m, output).not.toBeNull();
    const [, pid, code, signal, files] = m!;
    expect(Number(pid)).toBeGreaterThan(0);
    expect(files?.trim()).toBe('dies.fixture.ts');
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

  it('with a report directory, the file of the dead worker is reported unfinished, never passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-report-'));
    try {
      const { status, output } = runFixture('dies', dir);
      expect(status, output).toBe(1);
      const exits = readFileSync(join(dir, `${NAME}.worker-exits.log`), 'utf8');
      expect(exits).toMatch(LINE);
      expect(exits).toContain('files=dies.fixture.ts');
      const report = JSON.parse(
        readFileSync(join(dir, `${NAME}.vitest-report.json`), 'utf8'),
      ) as RunReport;
      expect(report.package).toBe(NAME);
      expect(report.unfinished).toEqual(['dies.fixture.ts']);
      expect(report.files.map((f) => [f.file, f.state, f.tests])).toEqual([
        ['dies.fixture.ts', 'pending', { pending: 1 }],
      ]);
      expect(report.unhandledErrors.join('\n')).toMatch(/Worker .* emitted error/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
