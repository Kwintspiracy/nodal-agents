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

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Le VRAI dossier temporaire du système, lu dans l'environnement et non via
 * `os.tmpdir()`. Le test de confinement bouchonne `node:os` — ce module s'en
 * tiendrait alors à la fausse racine, et `makeOutsideDir` créerait son dossier
 * DEDANS, exactement le défaut qu'on corrige. Ce module n'importe donc PAS
 * `node:os` du tout : le bouchon l'importe, et une dépendance en retour le
 * rendrait réentrant. `os.tmpdir()` ne lit de toute façon rien d'autre que ces
 * variables ; `/tmp` est son propre repli quand aucune n'est posée (POSIX
 * seulement — Windows pose toujours TEMP).
 */
function realTmpBase(): string {
  const fromEnv = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  return fromEnv && fromEnv.length > 0 ? path.resolve(fromEnv) : '/tmp';
}

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
  path.parse(realTmpBase()).root,
  '__nodal-hors-de-toute-racine__',
);

/** Un fichier (inexistant) sous {@link SYNTHETIC_OUTSIDE_DIR}. */
export function syntheticOutsideSource(filename: string): string {
  return path.join(SYNTHETIC_OUTSIDE_DIR, filename);
}

/**
 * Pour les tests qui écrivent VRAIMENT sur le disque, on ne cherche pas un
 * emplacement inscriptible hors du dossier temporaire — il n'y en a pas
 * toujours : le bac à sable `workspace-write` de codex n'ouvre en écriture que
 * le dépôt et le dossier temporaire, et quand le dépôt est lui-même sous
 * %TEMP% il ne reste rien. Constat de revue Codex sur cette PR, après une
 * première version qui écrivait dans le dossier personnel.
 *
 * On déplace donc la frontière au lieu de la fuir : le test bouchonne
 * `os.tmpdir()` pour qu'il rende {@link makeFakeTmpRoot}, un dossier neuf sous
 * le VRAI dossier temporaire. Un frère de ce dossier ({@link makeOutsideDir})
 * est alors hors de toute racine autorisée, tout en restant inscriptible
 * partout.
 *
 * Les deux dossiers sont uniques par appel (`mkdtemp`) : la première version
 * rendait un nom déterministe que `afterAll` supprime récursivement, donc deux
 * exécutions concurrentes s'effaçaient mutuellement leurs fixtures — second
 * constat de la même revue.
 */
const PREFIX = 'nodal-outside-';

/** Dossier neuf destiné à être rendu par un `tmpdir()` bouchonné. */
export function makeFakeTmpRoot(label: string): string {
  return mkdtempSync(path.join(realTmpBase(), `${PREFIX}${label}-tmproot-`));
}

/**
 * Dossier neuf, frère du précédent sous le vrai dossier temporaire : hors du
 * `tmpdir()` que voit la garde, donc hors de toute racine autorisée.
 */
export function makeOutsideDir(label: string): string {
  return mkdtempSync(path.join(realTmpBase(), `${PREFIX}${label}-outside-`));
}

/**
 * Racine temporaire de bouchon, créée une seule fois par processus de test :
 * le bouchon de `node:os` appelle ceci à chaque `tmpdir()`, et une nouvelle
 * racine à chaque appel ferait sortir les fixtures déjà écrites de la racine
 * autorisée.
 */
let memoizedFakeTmpRoot: string | undefined;
export function fakeTmpRootFor(label: string): string {
  memoizedFakeTmpRoot ??= makeFakeTmpRoot(label);
  return memoizedFakeTmpRoot;
}

/**
 * Supprime la racine temporaire de bouchon — et elle seule : la variable
 * mémoïsée ne contient que ce que {@link makeFakeTmpRoot} a créé dans ce
 * processus. Sans ce garde-fou, un `rm(tmpdir())` écrit dans le test
 * effacerait le vrai dossier temporaire le jour où le bouchon disparaît.
 */
export async function cleanupFakeTmpRoot(): Promise<void> {
  if (!memoizedFakeTmpRoot) return;
  const dir = memoizedFakeTmpRoot;
  memoizedFakeTmpRoot = undefined;
  await rm(dir, { recursive: true, force: true });
}
