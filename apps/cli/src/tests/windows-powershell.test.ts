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
// Without the fix, on GitHub's Windows image, each of these reads takes 18 to
// 25 s (CI Windows runs 43013145133, 43014243488): the table read then comes
// back empty at its 6 s budget and the cases go red. On a machine with few
// modules the reads are fast either way, which is why the proof is the CI run.
//
// The last block runs everywhere: one way to spawn PowerShell, and only one.

import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSourceFiles } from '@nodal-agents/test-kit';
import { processSnapshotWin } from '../lib/processes.ts';
import { postgresProcessesForDataDir, queryPidDirectWin } from '../lib/postgres.ts';
import { PIN_SYSTEM_MODULES, windowsPowerShellArgs } from '../lib/windows-powershell.ts';

const onWindows = process.platform === 'win32';

/** The shutdown budget of `processes.ts` (`SHUTDOWN_SNAPSHOT_BUDGET_MS`). */
const SHUTDOWN_BUDGET_MS = 6_000;

const STRIPPED = ['PSMODULEPATH', 'PSMODULEANALYSISCACHEPATH'];
const saved: [string, string][] = [];

describe.runIf(onWindows)(
  'PowerShell reads without the caller’s module path @cap:installer-et-demarrer/moteur',
  () => {
    beforeAll(() => {
      // Windows names are case-insensitive; node keeps the case they came in.
      for (const key of Object.keys(process.env)) {
        if (!STRIPPED.includes(key.toUpperCase())) continue;
        saved.push([key, process.env[key] ?? '']);
        delete process.env[key];
      }
      // The point of the file: if either survived, nothing below proves anything.
      expect(Object.keys(process.env).filter((k) => STRIPPED.includes(k.toUpperCase()))).toEqual(
        [],
      );
    });

    afterAll(() => {
      for (const [key, value] of saved.splice(0)) process.env[key] = value;
    });

    it('reads the whole process table well inside the shutdown budget, this process included', async () => {
      const started = Date.now();
      const table = await processSnapshotWin(SHUTDOWN_BUDGET_MS);
      const took = Date.now() - started;
      process.stderr.write(`[tests] windows-powershell: table read took ${took} ms\n`);

      const self = table.get(process.pid);
      expect(
        self,
        `the table did not list this process (${table.size} rows, ${took} ms)`,
      ).toBeDefined();
      expect(self?.name?.toLowerCase()).toBe('node.exe');
      expect(self?.ppid).toBe(process.ppid);
      expect(self?.startedAt).toMatch(/^\d+$/);
      expect(took).toBeLessThan(SHUTDOWN_BUDGET_MS);
    }, 30_000);

    it('answers the postgres probe and the one-pid query', async () => {
      const started = Date.now();
      const probe = await postgresProcessesForDataDir();
      const direct = await queryPidDirectWin(process.pid);
      const took = Date.now() - started;
      process.stderr.write(`[tests] windows-powershell: probe + one-pid query took ${took} ms\n`);

      // `read: true` is the probe saying it looked, not that it found anything.
      expect(probe.read).toBe(true);
      expect(direct?.exe.toLowerCase()).toBe('node.exe');
      expect(direct?.startedAt).toBeGreaterThan(0);
      expect(took).toBeLessThan(SHUTDOWN_BUDGET_MS);
    }, 40_000);
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
