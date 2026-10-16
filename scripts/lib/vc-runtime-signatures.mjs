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

/** The fixed PowerShell text: paths and names arrive through the environment. */
export const POWERSHELL_SCRIPT =
  `foreach ($n in $env:${ENV_NAMES} -split ',') { ` +
  `$s = Get-AuthenticodeSignature -LiteralPath (Join-Path $env:${ENV_DIR} $n); ` +
  `"$n|$($s.Status)|$($s.SignerCertificate.Subject)" }`;

export const EXPECTED_SUBJECT = 'O=Microsoft Corporation';

/**
 * @param {string} output  one `name|Status|Subject` line per DLL
 * @param {readonly string[]} dlls  every DLL that must have a line
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function judgeSignatures(output, dlls) {
  /** @type {Map<string, { status: string, subject: string }>} */
  const seen = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [name, status, ...rest] = line.trim().split('|');
    if (name && status !== undefined) seen.set(name, { status, subject: rest.join('|') });
  }
  const problems = [];
  for (const dll of dlls) {
    const sig = seen.get(dll);
    if (!sig) problems.push(`${dll}: no signature line in the output`);
    else if (sig.status !== 'Valid') problems.push(`${dll}: status ${sig.status}, expected Valid`);
    else if (!sig.subject.includes(EXPECTED_SUBJECT)) {
      problems.push(`${dll}: subject "${sig.subject}" does not contain ${EXPECTED_SUBJECT}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
