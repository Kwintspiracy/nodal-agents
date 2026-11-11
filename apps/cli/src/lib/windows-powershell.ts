// windows-powershell.ts — the ONE way the CLI runs Windows PowerShell (#1057).
//
// Every PowerShell call the CLI makes reads the process table: the whole table
// (`processes.ts`), the postgres processes and one pid (`postgres.ts`). Each
// used to spawn `powershell` its own way, and each depended, without saying so,
// on the environment of whoever had started `nodal`.
//
// ## What it depended on
//
// A cmdlet that is not loaded yet (`Get-CimInstance`, `Get-WmiObject`,
// `Get-Date`) is found by module discovery, which walks every directory of
// `PSModulePath`. With `PSModulePath` and `PSModuleAnalysisCachePath` absent from
// the environment, Windows PowerShell 5.1 builds its own path at startup — the
// system modules AND `%ProgramFiles%\WindowsPowerShell\Modules` — and analyses
// every module it finds there, with no cache. On GitHub's Windows image, which
// has hundreds of modules there, one read took 18 to 25 s (CI Windows runs
// 43013145133, 43014243488): longer than the 6 s shutdown budget and, often,
// the 20 s one. A service manager, a scheduled task, an IDE or another tool's
// child process can start `nodal` with exactly that environment, and the product
// itself strips `PSModulePath` from the commands it launches (#869).
//
// ## The form chosen, and the ones measured against it
//
// The script's FIRST statement pins the module path of the session to the
// system modules of the PowerShell that runs it: `$env:PSModulePath =
// "$PSHOME\Modules"`. It is a language statement, so it needs no module itself,
// and every cmdlet the script calls after it is found among the modules that
// ship with Windows — which is all a process-table read uses. Measured on the
// same runner, both variables removed: CIM 0.44 to 0.61 s, WMI 0.37 to 0.38 s;
// PowerShell's own startup is 0.19 s.
//
// Rejected, on measurement:
//   · setting `PSModulePath` in the CHILD's environment to the same directory:
//     still 18 s. Windows PowerShell 5.1 adds the Program Files directory back
//     when it starts, so the walk is the same;
//   · `Import-Module` of the one module by its path under `$PSHOME`: fast for
//     `Get-WmiObject` (0.4 s), still 18 s for `Get-CimInstance`, and it only
//     covers the cmdlets someone remembered to list (`Get-Date` was not);
//   · a script with no cmdlet at all (.NET `ManagementObjectSearcher`): fast,
//     but it rewrites every query into another API, and the first cmdlet a
//     later edit adds brings the defect back silently.
//
// The pin also keeps a module the user installed from shadowing a system
// cmdlet in our reads: they now run against what Windows ships, on every
// machine, whoever started us.
//
// The VC++ signature check (`scripts/verify-vc-runtime-signatures.mjs`, which
// drops `PSModulePath` on purpose, 169f1ec12) is a build script, not the CLI,
// and is left as it is.

import { execa } from 'execa';

/**
 * The first statement of every script: module discovery limited to the system
 * modules of the running PowerShell. `$PSHOME` is an automatic variable, so the
 * statement resolves on whatever Windows runs it.
 */
export const PIN_SYSTEM_MODULES = ''; // MUTATION (#1057): pin removed, throwaway branch only

/** The arguments `powershell` is given for `script`. */
export function windowsPowerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', PIN_SYSTEM_MODULES + script];
}

/** What a run returned. A spawn that failed outright still throws, as execa does. */
export interface WindowsPowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  timedOut: boolean;
}

/**
 * Run `script` in Windows PowerShell, bounded by `timeoutMs`. Never rejects on a
 * non-zero exit or a timeout: the caller reads `exitCode` and `timedOut`, and
 * says why a reading failed (invariant #4).
 */
export async function runWindowsPowerShell(
  script: string,
  timeoutMs: number,
): Promise<WindowsPowerShellResult> {
  const { stdout, stderr, exitCode, timedOut } = await execa(
    'powershell',
    windowsPowerShellArgs(script),
    { reject: false, timeout: timeoutMs },
  );
  return {
    stdout: String(stdout ?? ''),
    stderr: String(stderr ?? ''),
    exitCode,
    timedOut: timedOut === true,
  };
}
