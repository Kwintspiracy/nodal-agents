// vc-runtime-signatures.test.mjs — the verdict on the Authenticode output.

import { describe, it, expect } from 'vitest';
import {
  buildPowerShellEnv,
  judgeSignatures,
  POWERSHELL_SCRIPT,
  ENV_DIR,
  ENV_NAMES,
} from '../lib/vc-runtime-signatures.mjs';
import { VC_RUNTIME_SOURCE } from '../lib/vc-runtime-source.mjs';
import { VC_RUNTIME_DLLS } from '../../apps/cli/src/lib/vc-runtime.ts';

const DLLS = ['a.dll', 'b.dll'];
const MS = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';

describe('judgeSignatures', () => {
  it('accepts a Valid Microsoft signature on every DLL (CRLF output included)', () => {
    const out = `a.dll|C:/x/a.dll|Valid|${MS}\r\nb.dll|C:/x/b.dll|Valid|${MS}\r\n`;
    expect(judgeSignatures(out, DLLS)).toEqual({ ok: true, problems: [] });
  });

  it('fails on a DLL with no line', () => {
    const v = judgeSignatures(`a.dll|C:/x/a.dll|Valid|${MS}\n`, DLLS);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(['b.dll: no signature line in the output.']);
  });

  it('fails on a NotSigned DLL (empty subject)', () => {
    const v = judgeSignatures(`a.dll|C:/x/a.dll|Valid|${MS}\nb.dll|C:/x/b.dll|NotSigned|\n`, DLLS);
    expect(v.problems).toEqual(['b.dll: status NotSigned for C:/x/b.dll, expected Valid']);
  });

  it('fails on a Valid signature from someone else', () => {
    const v = judgeSignatures(
      `a.dll|C:/x/a.dll|Valid|CN=Evil, O=Evil Inc\nb.dll|C:/x/b.dll|Valid|${MS}\n`,
      DLLS,
    );
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain('a.dll: subject "CN=Evil, O=Evil Inc"');
  });

  it('keeps a subject that itself contains the separator', () => {
    const v = judgeSignatures(
      `a.dll|C:/x/a.dll|Valid|O=Microsoft Corporation|x\nb.dll|C:/x/b.dll|Valid|${MS}`,
      DLLS,
    );
    expect(v.ok).toBe(true);
  });
});

describe('judgeSignatures when PowerShell produced nothing usable', () => {
  it('fails on an empty status, names the path and the stderr cause', () => {
    const out = 'a.dll|C:/x/a.dll||\nb.dll|C:/x/b.dll||\n';
    const v = judgeSignatures(out, DLLS, 'The term Get-AuthenticodeSignature is not recognized');
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(2);
    expect(v.problems[0]).toContain(
      'a.dll: PowerShell returned no signature at all for C:/x/a.dll',
    );
    expect(v.problems[0]).toContain('Get-AuthenticodeSignature is not recognized');
  });
});

describe('the DLL list and the script', () => {
  it('checks exactly the DLLs the pack ships (one list, two spellings)', () => {
    expect(Object.keys(VC_RUNTIME_SOURCE.files).sort()).toEqual([...VC_RUNTIME_DLLS].sort());
  });

  it('carries no path or name in the PowerShell text (they arrive through the environment)', () => {
    expect(POWERSHELL_SCRIPT).not.toMatch(/\.dll|[A-Za-z]:\\/);
  });
});

describe('buildPowerShellEnv', () => {
  it.each(['PSModulePath', 'PSMODULEPATH', 'psmodulepath'])('drops %s whatever its case', (key) => {
    const env = buildPowerShellEnv({ [key]: 'C:/pwsh7', PATH: 'p' }, 'D:/dir', ['a.dll']);
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('PSMODULEPATH');
    expect(env.PATH).toBe('p');
  });

  it('sets our two keys once, replacing the same keys in another case', () => {
    const base = { [ENV_DIR.toLowerCase()]: 'old', [ENV_NAMES.toLowerCase()]: 'old' };
    const env = buildPowerShellEnv(base, 'D:/dir', ['a.dll', 'b.dll']);
    expect(env).toEqual({ [ENV_DIR]: 'D:/dir', [ENV_NAMES]: 'a.dll,b.dll' });
  });
});
