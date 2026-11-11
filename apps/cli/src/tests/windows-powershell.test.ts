// windows-powershell.test.ts — the CLI's PowerShell reads do not depend on the
// environment of whoever started `nodal` (#1057).
//
// The Windows block runs REAL reads — the whole process table, the postgres
// probe, one pid — with `PSModulePath` and `PSModuleAnalysisCachePath` removed
// from the environment the child inherits. It strips both itself: the CI's
// turbo task passes `PSModuleAnalysisCachePath` through (#1058), and with it the
// read is fast whatever the product does, so a test relying on the CI's
// environment would pass for the wrong reason.
//
// WHAT IS COMPARED. A read without the two variables against a read with the
// environment this worker has, alternated, three pairs. Without the fix, on
// GitHub's Windows image, the stripped read takes 18 to 25 s against well under
// one (CI Windows runs 43013145133, 43014243488). With it, both take the same
// time. An absolute bound alone ("under 6 s") does not separate the two: in a
// loaded CI shard EVERY read slows down, the full-environment one included —
// measured with the CPUs saturated, run 43019338746: 2.3 to 5.8 s for the
// full-environment read, 2.5 to 4.4 s for the pinned one — and the first
// version of this test went red on load, not on the defect (run 43017579380).
//
// On a machine with few modules the reads are fast either way, which is why the
// proof is the CI run.
//
// The last block runs everywhere: one way to spawn PowerShell, and only one.

import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSourceFiles } from '@nodal-agents/test-kit';
import { processSnapshotWin, type ProcessRecord } from '../lib/processes.ts';
import { postgresProcessesForDataDir, queryPidDirectWin } from '../lib/postgres.ts';
import { PIN_SYSTEM_MODULES, windowsPowerShellArgs } from '../lib/windows-powershell.ts';

const onWindows = process.platform === 'win32';

/** The budget of a reading at start (`SNAPSHOT_BUDGET_MS` in processes.ts). */
const READ_BUDGET_MS = 20_000;

/**
 * How much slower the stripped read may be, median against median. The defect
 * is 15 s or more; two reads in a row on a loaded runner differ by 1 to 3 s.
 */
const MARGIN_MS = 3_000;

const STRIPPED = ['PSMODULEPATH', 'PSMODULEANALYSISCACHEPATH'];

/** Remove both variables (any case: Windows names are case-insensitive). Returns the undo. */
function stripModuleVariables(): () => void {
  const saved: [string, string][] = [];
  for (const key of Object.keys(process.env)) {
    if (!STRIPPED.includes(key.toUpperCase())) continue;
    saved.push([key, process.env[key] ?? '']);
    delete process.env[key];
  }
  // The point of the file: if either survived, nothing below proves anything.
  expect(Object.keys(process.env).filter((k) => STRIPPED.includes(k.toUpperCase()))).toEqual([]);
  return () => {
    for (const [key, value] of saved) process.env[key] = value;
  };
}

async function timedRead(): Promise<{ ms: number; self: ProcessRecord | undefined; rows: number }> {
  const started = Date.now();
  const table = await processSnapshotWin(READ_BUDGET_MS);
  return { ms: Date.now() - started, self: table.get(process.pid), rows: table.size };
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

describe.runIf(onWindows)(
  'PowerShell reads without the caller’s module path @cap:installer-et-demarrer/moteur',
  () => {
    it('reads the process table as fast without the two variables as with them, this process included', async () => {
      // A reference read is only a reference if discovery is cheap in it.
      expect(
        Object.keys(process.env).some((k) => STRIPPED.includes(k.toUpperCase())),
        'this worker has neither PSModulePath nor PSModuleAnalysisCachePath: the comparison would prove nothing',
      ).toBe(true);

      const withThem: number[] = [];
      const without: number[] = [];
      for (let pair = 0; pair < 3; pair++) {
        withThem.push((await timedRead()).ms);
        const restore = stripModuleVariables();
        try {
          const read = await timedRead();
          without.push(read.ms);
          expect(
            read.self,
            `the stripped read did not list this process (${read.rows} rows, ${read.ms} ms)`,
          ).toBeDefined();
          expect(read.self?.name?.toLowerCase()).toBe('node.exe');
          expect(read.self?.ppid).toBe(process.ppid);
          expect(read.self?.startedAt).toMatch(/^\d+$/);
        } finally {
          restore();
        }
      }
      process.stderr.write(
        `[tests] windows-powershell: table read with the variables ${withThem.join(' / ')} ms, ` +
          `without ${without.join(' / ')} ms\n`,
      );
      expect(median(without)).toBeLessThan(median(withThem) + MARGIN_MS);
    }, 180_000);

    it('answers the postgres probe and the one-pid query without the two variables', async () => {
      const restore = stripModuleVariables();
      try {
        const started = Date.now();
        const probe = await postgresProcessesForDataDir();
        const direct = await queryPidDirectWin(process.pid);
        process.stderr.write(
          `[tests] windows-powershell: probe + one-pid query took ${Date.now() - started} ms\n`,
        );
        // Each call has a 10 s budget; without the fix each takes 18 s or more
        // and comes back unanswered. `read: true` is the probe saying it looked.
        expect(probe.read).toBe(true);
        expect(direct?.exe.toLowerCase()).toBe('node.exe');
        expect(direct?.startedAt).toBeGreaterThan(0);
      } finally {
        restore();
      }
    }, 60_000);
  },
);

describe('one way to run PowerShell @cap:installer-et-demarrer/moteur', () => {
  it('pins module discovery to the system modules, before the script', () => {
    expect(windowsPowerShellArgs('Get-Date')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$env:PSModulePath = "$PSHOME\\Modules"; Get-Date',
    ]);
    expect(PIN_SYSTEM_MODULES.endsWith('; ')).toBe(true);
  });

  it('no product file of the CLI or the runner spawns PowerShell around the helper', () => {
    const repo = resolve(__dirname, '..', '..', '..', '..');
    const roots = ['apps/cli/src', 'apps/runner/src'].map((r) => join(repo, r));
    // A literal `powershell` / `pwsh` as the program of a spawn call.
    const SPAWN =
      /\b(?:execa|execaSync|spawn|spawnSync|execFile|execFileSync)\(\s*['"`](?:powershell|pwsh)(?:\.exe)?['"`]/i;
    // What git tracks as source, tests left out — never a list of build folders
    // of our own (test-kit `source-files.test.ts` refuses one).
    const files = roots.flatMap((root) =>
      listSourceFiles(root, {
        skipDirs: ['tests', '__tests__'],
        extensions: ['.ts', '.mts', '.js', '.mjs'],
      }),
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) => SPAWN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repo, file).split(sep).join('/'));
    expect(offenders).toEqual(['apps/cli/src/lib/windows-powershell.ts']);
  });
});
