// policy.ts — CE QU'UNE COMMANDE CONFINÉE PEUT ÉCRIRE, en un seul endroit (#628).
//
// L'étape 1 du bac à sable confine les ÉCRITURES des commandes qu'un agent
// lance (`run_command`, `run_skill_script`, les commandes de preuve de
// `declare_verification`). La lecture et le réseau restent ouverts.
//
// Une commande confinée peut écrire dans quatre sortes de dossiers, et nulle
// part ailleurs :
//
//   1. les dossiers du job : ses workspaces (partagé compris) et le dossier
//      attaché à la demande — l'APPELANT les donne (`writableRoots`), parce
//      que lui seul sait pour quel job il lance la commande. Aucun état global
//      ne les devine ;
//   2. un temporaire PAR COMMANDE, supprimé après elle. Sous Windows, MXC le
//      fournit lui-même : il remplace TEMP/TMP et LOCALAPPDATA par un profil
//      AppContainer jetable, quoi qu'on lui passe (mesuré le 14/10 : TEMP
//      passé = un dossier du workspace, TEMP vu = `…\Packages\sandbox.{GUID}\AC\Temp`) ;
//   3. les caches d'outils de Nodal (`toolCacheRoot()`), désignés aux outils
//      par variable d'environnement (`toolCacheEnv()`) — sans eux, `npm
//      install` repart d'un cache vide à chaque commande sous MXC, et échoue
//      avec un message trompeur sous Landlock (essais #731 et #733) ;
//   4. rien d'autre. Le réglage « dossiers permis » que l'utilisateur pourra
//      étendre (décision D3) viendra avec l'écran qui le montre.

import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Ce que l'appelant déclare pour UNE commande. */
export interface ConfinementPolicy {
  /**
   * Les dossiers du job où la commande peut écrire : ses workspaces et le
   * dossier attaché à la demande. Chemins absolus. Une liste VIDE est
   * permise et veut dire « nulle part hors du temporaire et des caches » —
   * jamais « partout ».
   */
  readonly writableRoots: readonly string[];
}

/**
 * Le dossier des caches d'outils, propriété de Nodal. Surchargeable pour les
 * tests (même convention que NODALAI_WORKSPACES_ROOT) : une suite qui lance
 * `npm install` confiné ne doit jamais écrire dans le vrai dossier personnel.
 */
export function toolCacheRoot(): string {
  return process.env['NODALAI_TOOL_CACHE_ROOT'] ?? join(homedir(), '.nodalai', 'tool-cache');
}

/**
 * LA liste des variables qui désignent un cache d'outil, et le sous-dossier
 * de `toolCacheRoot()` où chacune pointe. Un seul endroit, documenté ici :
 *
 *   - `npm_config_cache` : le cache de npm (et de npx). Sans lui, npm écrit
 *     dans `%LOCALAPPDATA%\npm-cache` ou `~/.npm`, hors des dossiers permis ;
 *   - `npm_config_store_dir`, `npm_config_cache_dir` : le magasin et le cache
 *     de métadonnées de pnpm, qui lit la configuration npm par environnement ;
 *   - `YARN_CACHE_FOLDER` : le cache de yarn 1 ;
 *   - `PIP_CACHE_DIR` : le cache de pip ;
 *   - `UV_CACHE_DIR` : le cache de uv.
 *
 * Posées pour TOUTE commande, confinée ou non : une commande ne change pas
 * de cache selon que le bac à sable est disponible. Un outil absent de cette
 * liste écrit où il veut, et sous confinement ce sera refusé : c'est le
 * signal pour l'ajouter ici, jamais pour élargir les dossiers permis.
 */
export const TOOL_CACHE_VARIABLES: Readonly<Record<string, string>> = {
  npm_config_cache: 'npm',
  npm_config_store_dir: 'pnpm-store',
  npm_config_cache_dir: 'pnpm-cache',
  YARN_CACHE_FOLDER: 'yarn',
  PIP_CACHE_DIR: 'pip',
  UV_CACHE_DIR: 'uv',
};

/** Les variables de cache, chacune vers son dossier, créés au besoin. */
export function toolCacheEnv(): Record<string, string> {
  const root = toolCacheRoot();
  const env: Record<string, string> = {};
  for (const [name, sub] of Object.entries(TOOL_CACHE_VARIABLES)) {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    env[name] = dir;
  }
  return env;
}

/**
 * Les dossiers réellement inscriptibles d'une commande, prêts pour un backend :
 * absolus, avec leur chemin RÉSOLU à côté quand il diffère (un workspace qui
 * est une jonction vers un autre disque ne s'écrit qu'à travers sa cible —
 * mesure 1i de l'essai MXC : une jonction préexistante vers un dossier non
 * permis ne laisse pas passer l'écriture), sans doublon. Le cache d'outils
 * est ajouté ici, pour tous les appelants.
 *
 * Un chemin relatif est une erreur de l'appelant : on échoue fort plutôt que
 * de le résoudre contre le dossier courant du runner (invariant #4).
 */
export function resolveWritableRoots(policy: ConfinementPolicy): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const root of [...policy.writableRoots, toolCacheRoot()]) {
    if (!isAbsolute(root)) {
      throw new Error(`SANDBOX_ROOT_NOT_ABSOLUTE: ${root}`);
    }
    const abs = resolve(root);
    add(abs);
    try {
      add(realpathSync.native(abs));
    } catch {
      // Un dossier qui n'existe pas encore n'a pas de chemin résolu : on le
      // déclare tel quel, MXC l'accepte sans le créer (mesure 5).
    }
  }
  return out;
}
