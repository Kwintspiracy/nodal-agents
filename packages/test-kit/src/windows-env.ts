// windows-env.ts — les variables de profil Windows qu'un worker de test doit
// recevoir, y compris sous `pnpm turbo run test` (release:check de 0.9.8).
//
// Turbo, en mode strict, ne laisse passer aux tâches que sa liste Windows par
// défaut (APPDATA, COMSPEC, HOMEDRIVE, HOMEPATH, PROGRAMDATA, PROGRAMFILES,
// SYSTEMDRIVE, SYSTEMROOT, TEMP, TMP, USERPROFILE, WINDIR, PATH, PATHEXT…). Les
// autres, dont `LOCALAPPDATA`, sont ôtées de l'environnement des workers (mesuré
// le 23/10 : 115 variables en vitest nu, 64 sous turbo). Or le bac à sable en a
// besoin : `LOCALAPPDATA` est exigée par MXC (`policy_validation … missing the
// required variable(s): LOCALAPPDATA`), le test d'ouverture d'un conteneur la
// copie de process.env, et sans elle toute preuve sur une vraie machine
// (deny-data-dir, sandbox-proxy-windows, windows-mxc) échoue en
// SANDBOX_SELF_TEST_FAILED. La CI ne le voit pas : le runner GitHub n'a pas le
// palier base-container, ces suites s'y sautent.
//
// La liste est celle que le PRODUIT transmet aux commandes (l'allowlist
// Windows de packages/tools/src/builtin/child-env.ts), moins ce que turbo laisse
// déjà passer : un test qui prouve ce que voit une commande doit le voir lui-même.
// turbo.json (`tasks.test.passThroughEnv`) porte la même liste ; windows-env.test.ts
// les compare.

/** Les variables de profil Windows ôtées par turbo, et qu'un worker de test doit voir. */
export const WINDOWS_PROFILE_ENV = [
  // Exigée par MXC pour ouvrir un conteneur ; copiée par les tests de vraie machine.
  'LOCALAPPDATA',
  // Identité de l'utilisateur : packages/secrets et apps/cli la lisent (USERNAME)
  // pour nommer le coffre et le dossier de configuration.
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  // Transmises aux commandes par l'allowlist du produit (child-env.ts) : un test
  // de ce qu'une commande voit les lit sur l'hôte.
  'PUBLIC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
] as const;

/** Celles de la liste qui manquent à `env` (casse ignorée : Windows). */
export function missingWindowsProfileEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const present = new Set(
    Object.entries(env)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k.toUpperCase()),
  );
  return WINDOWS_PROFILE_ENV.filter((n) => !present.has(n));
}
