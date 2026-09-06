// project-roots.ts — la règle « ce chemin appartient à QUEL projet », posée
// une fois, pour tout le dépôt.
//
// POURQUOI ICI. L'intention de mutation du plan « Vérifier & Corriger » doit
// répondre à cette question depuis `packages/tools` (les outils y vivent), la
// finalisation depuis le runner, et l'onglet Code depuis le web. La règle
// existe déjà DEUX fois — `projectRootFor` / `within`
// (apps/runner/src/job/code-projects.ts) et `projectUnderWorkspace`
// (apps/web/src/lib/code-projects.ts) — et le commentaire du runner dit
// lui-même pourquoi c'est dangereux : « un désaccord entre elles ne se voit
// depuis aucun écran ». En écrire une troisième dans `tools` aurait fait de
// l'intention de mutation et de l'affichage deux vérités concurrentes sur
// l'identité d'un livrable. C'est donc la version PARTAGÉE, et les deux
// copies existantes sont à retirer quand leurs paquets pourront être touchés.
//
// FONCTION PURE, sans aucun import `node:` — ce module est bundlé côté client
// avec le reste de `@nodal-agents/shared`. La lecture du disque (existence
// d'un manifeste, énumération des sous-dossiers) est INJECTÉE par l'appelant
// via `hasMarker`, jamais faite ici.

import { isWindowsPath, normalizePath, projectKey } from './project-key';
import type { DeliverableType } from './types/verification';

/**
 * Ce qu'un outil s'apprête à toucher. `kind` tranche une ambiguïté qu'aucun
 * chemin ne porte : `C:/dev/app/src` peut être le fichier `src` ou le dossier
 * `src`, et le projet n'est pas le même (`app` dans un cas, `app` aussi ici,
 * mais `C:/dev/app` vs `C:/dev` dès que la racine attachée est `C:/dev`).
 * L'outil SAIT lequel des deux il vise ; le résolveur ne le devine pas.
 */
export interface MutationTarget {
  readonly kind: 'file' | 'dir';
  readonly path: string;
  /**
   * CE QUE cet appel produit — pas où il l'écrit (v7-A).
   *
   * Le type était codé en dur à `'code_project'` dans le helper d'intention,
   * si bien qu'un tableur écrit dans un dépôt marquait le DÉPÔT comme modifié
   * et relançait ses tests, alors que pas une ligne de code n'avait bougé.
   * L'outil sait ce qu'il produit ; il le déclare, et la vérification range
   * chaque livrable dans sa catégorie.
   *
   * Obligatoire, jamais par défaut : un outil mutant ajouté demain doit être
   * une erreur du compilateur, pas un livrable rangé au hasard.
   */
  readonly deliverableType: DeliverableType;
}

/** Un projet touché : sa clé d'identité, et le chemin à afficher. */
export interface ProjectRoot {
  /** `projectKey(path)` — l'identité canonique, et l'ordre de verrouillage. */
  readonly key: string;
  /** Le chemin normalisé, tel qu'il sera montré au propriétaire. */
  readonly path: string;
}

export interface ResolveProjectRootsInput {
  readonly targets: readonly MutationTarget[];
  /** Les dossiers attachés à l'agent (labels ignorés — seuls les chemins comptent). */
  readonly workspaceRoots: readonly string[];
  /** « Ce dossier porte-t-il un manifeste ? » — injecté (aucun `node:` ici). */
  readonly hasMarker: (dir: string) => boolean;
}

/**
 * Les marqueurs de racine de projet — mêmes conventions que l'onglet Code.
 *
 * Exportés parce que `hasMarker` est injecté : sans cette liste partagée,
 * chaque appelant en choisirait une, et deux appelants finiraient par ne plus
 * voir le même projet au même endroit.
 */
export const PROJECT_MARKERS: readonly string[] = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'deno.json',
  'index.html',
];

/**
 * Une racine de disque (`/`, `C:`, `C:/`) n'est jamais un projet exploitable :
 * elle engloberait la machine entière, et le repli « sous-dossier de premier
 * niveau » en tirerait des projets nommés `Users` ou `home`.
 */
export function isDriveRoot(p: string): boolean {
  const s = p.replace(/\/+$/, '');
  return s === '' || s === '/' || /^[a-z]:$/i.test(s);
}

/**
 * `dir` est-il ce dossier, ou dedans ? Casse repliée UNIQUEMENT sur un chemin
 * Windows — la même règle que `projectKey`, et pour la même raison : sur un
 * système sensible à la casse, `/srv/App` et `/srv/app` sont deux dossiers.
 *
 * EXPORTÉE depuis P5 : le registre des projets doit répondre à la même
 * question (« cette cible tombe-t-elle dans ce projet enregistré ? »), et une
 * quatrième copie de la règle de frontière aurait fait un quatrième endroit où
 * `dev` peut se remettre à avaler `dev-notes`.
 */
export function isWithinRoot(dir: string, root: string): boolean {
  const isWin = isWindowsPath(dir) || isWindowsPath(root);
  const a = isWin ? dir.toLowerCase() : dir;
  const b = isWin ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + '/');
}

/**
 * Les projets touchés par une liste de cibles, dédupliqués, TRIÉS PAR CLÉ
 * CROISSANTE.
 *
 * L'ordre n'est pas cosmétique : c'est l'ordre de verrouillage qu'impose le
 * protocole transactionnel du plan (verrous pris sur `code_projects` par clé
 * croissante). Deux appelants qui verrouilleraient les mêmes lignes dans deux
 * ordres différents se bloqueraient mutuellement ; rendre la liste déjà triée
 * retire cette possibilité au lieu de la confier à la discipline de chacun.
 *
 * La règle elle-même est celle de l'onglet Code, mot pour mot : un projet est
 * un ENFANT DIRECT du dossier attaché, quelle que soit la profondeur du
 * fichier — sauf si le dossier attaché porte lui-même un manifeste, auquel cas
 * c'est LUI le projet (sans quoi attacher un dépôt afficherait `apps`,
 * `packages` et `docs` comme trois projets).
 *
 * Les racines sont essayées de la PLUS LONGUE à la plus courte : si l'agent
 * tient à la fois `C:/dev` et `C:/dev/app`, un fichier de `app` appartient au
 * projet le plus niché, pas au parent.
 */
export function resolveProjectRoots(input: ResolveProjectRootsInput): readonly ProjectRoot[] {
  const roots = input.workspaceRoots
    .map(normalizePath)
    .filter((r) => r !== '' && !isDriveRoot(r))
    .sort((a, b) => b.length - a.length);

  // Le manifeste d'une racine est lu une fois, pas une fois par cible.
  const markerMemo = new Map<string, boolean>();
  const rootIsProject = (root: string): boolean => {
    const cached = markerMemo.get(root);
    if (cached !== undefined) return cached;
    const value = input.hasMarker(root);
    markerMemo.set(root, value);
    return value;
  };

  const found = new Map<string, string>();
  for (const target of input.targets) {
    const p = normalizePath(target.path);
    if (p === '' || isDriveRoot(p)) continue;
    // Un fichier appartient au projet de SON DOSSIER — même découpe que
    // `projectRootFor` (`path.replace(/\/[^/]*$/, '')`).
    const dir = target.kind === 'dir' ? p : p.replace(/\/[^/]*$/, '');
    if (dir === '' || isDriveRoot(dir)) continue;

    const root = roots.find((r) => isWithinRoot(dir, r));
    // Hors de tout dossier attaché : aucun projet. Se rabattre sur une racine
    // au hasard serait salir un projet que personne n'a touché.
    if (root === undefined) continue;

    let projectPath: string;
    if (rootIsProject(root) || dir === root) {
      projectPath = root;
    } else {
      const child = dir.slice(root.length + 1).split('/')[0];
      projectPath = child ? `${root}/${child}` : root;
    }

    const key = projectKey(projectPath);
    // Premier chemin gagnant : la clé est l'identité, le chemin n'est que
    // l'affichage — deux casses du même dossier Windows n'en font pas deux.
    if (!found.has(key)) found.set(key, projectPath);
  }

  return [...found.entries()]
    .map(([key, path]) => ({ key, path }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Les livrables FICHIER touchés par une liste de cibles, dédupliqués, triés
 * par clé croissante.
 *
 * La contrepartie de `resolveProjectRoots` pour les livrables dont l'identité
 * est le FICHIER lui-même, pas le projet qui l'héberge (v7-A). Un tableur
 * écrit dans un dépôt est un livrable à part : il ne relance pas les tests du
 * dépôt, et le dépôt ne décide pas s'il est correct.
 *
 * La règle d'appartenance reste la même — hors de tout dossier attaché, aucun
 * livrable — parce qu'elle protège la même chose : un chemin qui a échappé au
 * contrôle de périmètre de l'outil ne doit pas créer d'état de vérification.
 * Un dossier n'est jamais un livrable fichier : `kind: 'dir'` est ignoré ici,
 * et l'appelant journalise ce qu'il a laissé de côté.
 */
export function resolveFileDeliverables(input: {
  readonly targets: readonly MutationTarget[];
  readonly workspaceRoots: readonly string[];
}): readonly ProjectRoot[] {
  const roots = input.workspaceRoots
    .map(normalizePath)
    .filter((r) => r !== '' && !isDriveRoot(r))
    .sort((a, b) => b.length - a.length);

  const found = new Map<string, string>();
  for (const target of input.targets) {
    if (target.kind !== 'file') continue;
    const p = normalizePath(target.path);
    if (p === '' || isDriveRoot(p)) continue;
    const dir = p.replace(/\/[^/]*$/, '');
    if (!roots.some((r) => isWithinRoot(dir, r))) continue;
    const key = projectKey(p);
    if (!found.has(key)) found.set(key, p);
  }

  return [...found.entries()]
    .map(([key, path]) => ({ key, path }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
