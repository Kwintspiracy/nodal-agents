// windows-env.test.ts — un worker de test Windows reçoit les variables de profil
// dont les preuves sur une vraie machine ont besoin, sous turbo aussi.
//
// Le garde échoue FORT en nommant la variable manquante : il ne saute jamais, et
// la suite qui en dépend (deny-data-dir, sandbox-proxy-windows, windows-mxc) n'a
// plus à découvrir l'absence par un SANDBOX_SELF_TEST_FAILED.
//
// Mutation vérifiée (annulée ensuite) : `passThroughEnv` retiré de `tasks.test`
// dans turbo.json → « a Windows test worker sees … » rouge sous
// `pnpm turbo run test --filter=@nodal-agents/test-kit` (LOCALAPPDATA…), et
// « turbo.json lets the Windows profile variables through » rouge partout.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WINDOWS_PROFILE_ENV, missingWindowsProfileEnv } from '../windows-env';

describe('Windows profile variables reach the test workers', () => {
  it('turbo.json lets the Windows profile variables through to `test` (tous systèmes)', () => {
    const turbo = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../turbo.json'), 'utf8'),
    ) as {
      tasks: { test: { passThroughEnv?: string[] } };
    };
    const passed = turbo.tasks.test.passThroughEnv ?? [];
    expect(
      WINDOWS_PROFILE_ENV.filter((n) => !passed.includes(n)),
      'variables the Windows test workers need that tasks.test.passThroughEnv does not pass',
    ).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'a Windows test worker sees every profile variable the sandbox proofs need',
    () => {
      expect(
        missingWindowsProfileEnv(),
        'missing from the worker environment (turbo strict env mode strips what is not in passThroughEnv): the sandbox proofs on a real machine cannot run',
      ).toEqual([]);
    },
  );

  it('missingWindowsProfileEnv names what is absent, ignoring case (tous systèmes)', () => {
    expect(missingWindowsProfileEnv({})).toEqual([...WINDOWS_PROFILE_ENV]);
    const full = Object.fromEntries(WINDOWS_PROFILE_ENV.map((n) => [n.toLowerCase(), 'x']));
    expect(missingWindowsProfileEnv(full)).toEqual([]);
    expect(missingWindowsProfileEnv({ ...full, localappdata: undefined })).toEqual([
      'LOCALAPPDATA',
    ]);
  });
});
