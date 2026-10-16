// vc-runtime-signatures.mjs — the verdict on the Authenticode signatures of the
// VC++ runtime DLLs the pack ships (0.9.7).
//
// Windows alone can verify an Authenticode signature, through PowerShell, and a
// cold PowerShell on a loaded CI runner took more than 80 s inside the parallel
// unit suite (CI Windows, 2026-10-17). So the check is not a vitest case: it is
// scripts/verify-vc-runtime-signatures.mjs, a step of its own run BEFORE the
// unit suite. This file holds the pure part — the script text and the reading
// of its output — so that the verdict can be tested without Windows.

/** Read by the PowerShell script from the environment, never interpolated. */
export const ENV_DIR = 'VC_RUNTIME_DIR';
export const ENV_NAMES = 'VC_RUNTIME_DLLS';

/**
 * The fixed PowerShell text: paths and names arrive through the environment.
 * Every error is fatal (`Stop`): Get-AuthenticodeSignature raises non-terminating
 * errors, and without it a broken run printed empty fields and exited 0 (CI
 * Windows run 38956414993). Each line carries the resolved path it checked.
 */
export const POWERSHELL_SCRIPT =
  `$ErrorActionPreference = 'Stop'; ` +
  `foreach ($n in $env:${ENV_NAMES} -split ',') { ` +
  `$p = Join-Path $env:${ENV_DIR} $n; ` +
  `$s = Get-AuthenticodeSignature -LiteralPath $p; ` +
  `"$n|$p|$($s.Status)|$($s.SignerCertificate.Subject)" }`;

/**
 * The environment of the spawned powershell.exe 5.1. PSModulePath is dropped (a
 * pwsh 7 parent's value breaks 5.1's Security module), and so are our own two
 * keys, in ANY case: Windows reads the environment case-insensitively, so a
 * `psmodulepath` or `vc_runtime_dir` left in the block would still win or clash.
 * @param {Record<string, string | undefined>} base
 * @param {string} dir
 * @param {readonly string[]} dlls
 */
export function buildPowerShellEnv(base, dir, dlls) {
  const drop = new Set(['PSMODULEPATH', ENV_DIR, ENV_NAMES].map((k) => k.toUpperCase()));
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!drop.has(k.toUpperCase())) env[k] = v;
  env[ENV_DIR] = dir;
  env[ENV_NAMES] = dlls.join(',');
  return env;
}

export const EXPECTED_SUBJECT = 'O=Microsoft Corporation';

/**
 * @param {string} output  one `name|path|Status|Subject` line per DLL
 * @param {readonly string[]} dlls  every DLL that must have a line
 * @param {string} [stderr]  what PowerShell wrote to stderr, named in every problem
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function judgeSignatures(output, dlls, stderr = '') {
  /** @type {Map<string, { path: string, status: string, subject: string }>} */
  const seen = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [name, path, status, ...rest] = line.trim().split('|');
    if (name && status !== undefined) seen.set(name, { path, status, subject: rest.join('|') });
  }
  const cause = stderr.trim() ? ` PowerShell stderr: ${stderr.trim()}` : '';
  const problems = [];
  for (const dll of dlls) {
    const sig = seen.get(dll);
    if (!sig) problems.push(`${dll}: no signature line in the output.${cause}`);
    else if (sig.status === '') {
      problems.push(
        `${dll}: PowerShell returned no signature at all for ${sig.path} (an error it did not raise?).${cause}`,
      );
    } else if (sig.status !== 'Valid') {
      problems.push(`${dll}: status ${sig.status} for ${sig.path}, expected Valid`);
    } else if (!sig.subject.includes(EXPECTED_SUBJECT)) {
      problems.push(
        `${dll}: subject "${sig.subject}" does not contain ${EXPECTED_SUBJECT} (${sig.path})`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}
