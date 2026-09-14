// outside-roots.ts — construire un chemin « hors de toute racine autorisée »
// sans dépendre de l'endroit où le dépôt est cloné.
//
// `assertLocalSourceAllowed` autorise trois familles de racines : les
// workspaces de l'agent (fournis par le test lui-même), le dossier de skills
// (idem) et `tmpdir()` — cette dernière inconditionnellement et hors du
// contrôle du test. Les tests de confinement construisaient leur chemin
// interdit à partir de `process.cwd()` ; dans un clone situé SOUS le dossier
// temporaire (un worktree sous %TEMP%, cas courant sous Windows), ce chemin
// tombe DANS `tmpdir()` et la garde l'autorise : cinq tests passaient au vert
// ou au rouge selon l'emplacement du clone, ce qui ne prouve rien (issue #90).
//
// Les deux helpers ci-dessous choisissent le chemin EXPLICITEMENT hors de
// `tmpdir()`, et échouent bruyamment plutôt que de rendre un chemin douteux.

import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** Normalisation identique à celle de la garde : résolue, insensible à la casse sous Windows. */
function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `true` si `child` est `parent` ou vit dessous. Même règle de préfixe que la garde. */
export function isUnderPath(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Dossier SYNTHÉTIQUE placé directement à la racine du volume de `tmpdir()`.
 * Il n'est jamais créé sur disque : il ne sert qu'aux tests qui bouchonnent
 * `realpath` en identité, donc l'existence du fichier n'est pas consultée.
 *
 * Pourquoi il ne peut être sous aucune racine autorisée : `tmpdir()` compte au
 * moins un segment sous la racine du volume (`C:\Users\…\Temp`, `/tmp`), et ce
 * segment n'est jamais ce nom-ci ; il n'est donc pas sous `tmpdir()`. Il ne
 * dérive d'aucun `cwd`, donc l'emplacement du clone ne l'atteint pas. Et les
 * tests concernés ne déclarent ni workspace ni dossier de skills.
 */
export const SYNTHETIC_OUTSIDE_DIR = path.join(
  path.parse(tmpdir()).root,
  '__nodal-hors-de-toute-racine__',
);

/** Un fichier (inexistant) sous {@link SYNTHETIC_OUTSIDE_DIR}. */
export function syntheticOutsideSource(filename: string): string {
  return path.join(SYNTHETIC_OUTSIDE_DIR, filename);
}

/**
 * Dossier RÉEL et inscriptible garanti hors de `tmpdir()`, pour les tests qui
 * touchent vraiment le disque. La racine du volume ne convient pas — y écrire
 * demande des privilèges — donc on prend le premier candidat inscriptible qui
 * ne tombe pas sous `tmpdir()` : le dossier personnel d'abord (sous Windows,
 * `tmpdir()` est un descendant du dossier personnel, jamais l'inverse), le
 * répertoire courant ensuite. Si aucun ne convient, on échoue bruyamment
 * plutôt que de rendre un chemin que la garde autoriserait (invariant #4).
 *
 * Le dossier n'est pas créé ici : l'appelant le crée et le supprime.
 */
export function outsideEveryRootDir(label: string): string {
  const bases = [homedir(), process.cwd()];
  for (const base of bases) {
    if (!base) continue;
    const dir = path.join(base, `.nodal-outside-${label}`);
    if (!isUnderPath(dir, tmpdir())) return dir;
  }
  throw new Error(
    `outsideEveryRootDir("${label}") : aucun emplacement inscriptible hors de tmpdir() ` +
      `(${tmpdir()}) parmi [${bases.join(', ')}]. Un test de confinement construit ici ` +
      `prouverait le contraire de ce qu'il annonce.`,
  );
}
