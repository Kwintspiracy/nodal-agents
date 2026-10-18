// workflows/fixtures.ts — les fichiers qu'un scénario pose AVANT la demande.
//
// « Modifie ce classeur », « corrige ce bug » : la demande porte sur un fichier
// qui existe déjà. Le banc l'apporte lui-même, depuis packages/bench/fixtures/
// (versionné, écrit par `make-fixtures.ts`), dans le dossier du banc de
// l'espace de travail PARTAGÉ — le premier des dossiers de travail, celui que
// le produit résout lui-même (`readWorkspaceRoots`). Il n'écrit jamais
// ailleurs que sous `nodal-bench/`.
//
// Le juge relit la fixture d'origine ici même : « rien d'autre n'a changé » se
// compare au fichier du dépôt, pas à un souvenir.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_DIR } from './disk';
import type { FixtureInstall } from './types';

export const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
);

/** Le chemin d'une fixture du dépôt ; une fixture absente est une erreur du banc, dite. */
export function fixturePath(name: string): string {
  const p = join(FIXTURES_DIR, name);
  if (!existsSync(p)) throw new Error(`workflow_fixture_missing: ${p}`);
  return p;
}

function assertBenchRel(rel: string): void {
  if (!rel.startsWith(`${BENCH_DIR}/`) || rel.split('/').includes('..')) {
    throw new Error(`workflow_refuses_write: ${rel} is outside the bench folder ${BENCH_DIR}/`);
  }
}

/** Le dossier de travail partagé : le premier que l'espace déclare. */
export function sharedRoot(roots: readonly string[]): string {
  const r = roots[0];
  if (!r) throw new Error('workflow_no_workspace: the workspace declares no working folder');
  return r;
}

/**
 * Efface, sous chaque dossier de travail, ce qu'un essai précédent a laissé à
 * `rel` (un fichier ou un dossier entier). Seulement sous `nodal-bench/`.
 */
export function resetBenchPath(roots: readonly string[], rel: string): void {
  assertBenchRel(rel);
  for (const root of roots) {
    const p = join(root, rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

/**
 * Pose la fixture `name` (fichier ou dossier) à `rel` dans le dossier de
 * travail partagé, après avoir effacé ce qui s'y trouvait dans TOUS les
 * dossiers de travail (un vieux résultat ailleurs ferait juger l'essai du jour
 * sur celui de la veille).
 */
export function installFixture(roots: readonly string[], name: string, rel: string): string {
  const from = fixturePath(name);
  resetBenchPath(roots, rel);
  const to = join(sharedRoot(roots), rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  return to;
}

/** L'empreinte d'un fichier : deux fichiers de même empreinte ont le même contenu. */
export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Le fichier installé `rel` dans le dossier partagé : où, s'il existe, s'il a été écrit depuis `sinceMs`. */
export function installed(
  roots: readonly string[],
  rel: string,
  sinceMs: number,
): { path: string; exists: boolean; fresh: boolean } {
  const path = join(sharedRoot(roots), rel);
  const exists = existsSync(path);
  return { path, exists, fresh: exists && statSync(path).mtimeMs >= sinceMs };
}

/**
 * Prépare un essai à partir de ce que le scénario DÉCLARE : efface ses
 * sorties (`outputs`) dans tous les dossiers de travail, puis pose ses
 * fixtures (`fixtures`). Le seul chemin de préparation, pour tous les scénarios.
 */
export function prepareTrial(
  s: { readonly fixtures?: readonly FixtureInstall[]; readonly outputs?: readonly string[] },
  roots: readonly string[],
): void {
  for (const rel of s.outputs ?? []) resetBenchPath(roots, rel);
  for (const f of s.fixtures ?? []) installFixture(roots, f.from, f.to);
}
