// verify-vc-runtime-signatures.mjs — every VC++ runtime DLL the pack ships
// carries a valid Microsoft Authenticode signature. Windows only: only Windows
// can verify one. One PowerShell for all DLLs; fails loudly (exit 1) on a
// missing line, a status other than Valid, or a subject that is not Microsoft.
//
// A dedicated CI step, run before the unit suite (see lib/vc-runtime-signatures.mjs).
// Usage: node scripts/verify-vc-runtime-signatures.mjs

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VC_RUNTIME_SOURCE } from './lib/vc-runtime-source.mjs';
import {
  ENV_DIR,
  ENV_NAMES,
  POWERSHELL_SCRIPT,
  judgeSignatures,
} from './lib/vc-runtime-signatures.mjs';

if (process.platform !== 'win32') {
  console.error('verify-vc-runtime-signatures: Authenticode can only be verified on Windows.');
  process.exit(1);
}

const dir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'cli',
  'vc-runtime',
  'x64',
);
const dlls = Object.keys(VC_RUNTIME_SOURCE.files);

// PowerShell 5.1 is spawned from whatever shell runs the step. CI runs it under
// pwsh 7, whose PSModulePath (7.x modules) 5.1 would inherit and then fail to
// load Microsoft.PowerShell.Security from. Dropping it lets 5.1 compute its own.
const { PSModulePath: _inherited, ...env } = process.env;
const run = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT],
  {
    encoding: 'utf-8',
    timeout: 5 * 60_000,
    env: { ...env, [ENV_DIR]: dir, [ENV_NAMES]: dlls.join(',') },
  },
);
if (run.error || run.status !== 0) {
  console.error(
    `verify-vc-runtime-signatures: PowerShell failed (${run.error?.message ?? `exit ${run.status}`})
` +
      `stdout: ${run.stdout ?? ''}
stderr: ${run.stderr ?? ''}`,
  );
  process.exit(1);
}

process.stdout.write(run.stdout);
const verdict = judgeSignatures(run.stdout, dlls, run.stderr);
if (!verdict.ok) {
  for (const p of verdict.problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`OK ${dlls.length} DLL(s) carry a valid Microsoft Authenticode signature.`);
