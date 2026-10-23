// windows-env-derivation.test.ts — la liste des variables de profil Windows que
// turbo doit laisser passer aux workers de test se DÉRIVE de l'allowlist du
// produit ; elle n'est pas une troisième copie qui dérive en silence (revue de
// #869, passe 1).
//
//   exigé = allowlist du produit (`safeEnvAllowlistSnapshot()`)
//           − ce que turbo laisse déjà passer (`TURBO_WINDOWS_DEFAULTS`, épinglé)
//           − les noms POSIX / de chaîne d'outils (`NOT_A_WINDOWS_PROFILE_NAME`, épinglé ici)
//
// Trois assertions : cet ensemble égale `WINDOWS_PROFILE_ENV` ; `WINDOWS_PROFILE_ENV`
// ⊆ `turbo.json` `tasks.test.passThroughEnv` ; `PSMODULEPATH` n'y est pas (le produit
// la retire exprès des processus enfants). Un nom Windows ajouté à l'allowlist du
// produit fait échouer la première, en le nommant : il faut alors l'ajouter à
// `WINDOWS_PROFILE_ENV` ET à turbo.json, ou l'épingler comme non-Windows ci-dessous.
//
// Mutations vérifiées (annulées ensuite) :
//   - un nom Windows (`ALLUSERSPROFILE`) ajouté à l'allowlist de child-env.ts →
//     « the required set is derived from the product allowlist » rouge, le nom cité ;
//   - `PUBLIC` retiré de turbo.json → « WINDOWS_PROFILE_ENV is all in turbo.json » rouge
//     (et le garde du worker, sous `pnpm turbo run test`, côté test-kit) ;
//   - `PROGRAMFILES` retiré des défauts de turbo épinglés → la dérivation le nomme
//     comme exigé ;
//   - `PSMODULEPATH` ajouté à turbo.json → « PSMODULEPATH is not passed » rouge.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TURBO_WINDOWS_DEFAULTS, WINDOWS_PROFILE_ENV } from '@nodal-agents/test-kit';
import { safeEnvAllowlistSnapshot } from '../builtin/child-env';

/** Des noms de l'allowlist du produit qui ne sont pas des variables de profil Windows. */
const NOT_A_WINDOWS_PROFILE_NAME = new Set([
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'LC_*',
  'PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'LD_LIBRARY_PATH',
  'PKG_CONFIG_PATH',
  'NODE_PATH',
]);

const passThroughEnv = (): string[] => {
  const turbo = JSON.parse(readFileSync(resolve(__dirname, '../../../../turbo.json'), 'utf8')) as {
    tasks?: { test?: { passThroughEnv?: string[] } };
  };
  return turbo.tasks?.test?.passThroughEnv ?? [];
};

describe('the Windows variables turbo must pass to test workers derive from the product allowlist', () => {
  it('the required set is derived from the product allowlist, minus turbo’s defaults and the POSIX names', () => {
    const turboDefaults = new Set<string>(TURBO_WINDOWS_DEFAULTS);
    const derived = safeEnvAllowlistSnapshot()
      .filter((n) => !NOT_A_WINDOWS_PROFILE_NAME.has(n) && !turboDefaults.has(n))
      .sort();
    expect(
      derived,
      'child-env.ts allowlist names that turbo does not pass by default: add each to WINDOWS_PROFILE_ENV (test-kit windows-env.ts) and to turbo.json tasks.test.passThroughEnv, or pin it as non-Windows here',
    ).toEqual([...WINDOWS_PROFILE_ENV].sort());
  });

  it('WINDOWS_PROFILE_ENV is all in turbo.json tasks.test.passThroughEnv', () => {
    const passed = passThroughEnv();
    expect(
      WINDOWS_PROFILE_ENV.filter((n) => !passed.includes(n)),
      'in WINDOWS_PROFILE_ENV but not passed by turbo.json',
    ).toEqual([]);
  });

  it('PSMODULEPATH is not passed: the product drops it from child processes on purpose', () => {
    expect(passThroughEnv().map((n) => n.toUpperCase())).not.toContain('PSMODULEPATH');
  });
});
