// code-projects.ts — dérivation du PROJET d'un pipeline de code (décision
// Quentin 25/08). Un projet = la racine du DÉPÔT GIT au-dessus des fichiers
// touchés (repli : le workspace de l'agent ; toujours rien → tiroir
// « Autres »). Dérivé à l'affichage, jamais stocké : un projet naît de sa
// première activité et regroupe rétroactivement toutes les sessions du même
// repo. Seul l'ARCHIVAGE persiste (code_project_archives, 0083).
//
// Module séparé d'actions.ts : un fichier 'use server' ne peut exporter que
// des fonctions async — ces helpers sync (et testables) doivent vivre ici.

import { existsSync as fsExistsSync } from 'node:fs';

/** Chemin absolu ? (POSIX `/…` ou Windows `C:/…`, déjà slash-normalisé.) */
function isAbsoluteChangePath(p: string): boolean {
  return /^[a-z]:\//i.test(p) || p.startsWith('/');
}

/** Slash-normalisé, sans slash final. */
export const normPath = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Le même dossier, écrit différemment ? `C:\Dev`, `c:/Dev` et `C:/Dev/` sont
 * la même chose sur Windows (revue Codex, 26/08) : sans cette comparaison, la
 * propagation de la case ne touchait qu'une des écritures et les autres agents
 * gardaient une case vide.
 */
export function samePath(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return /^[a-z]:\//i.test(x) || /^[a-z]:\//i.test(y)
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

/** `child` est-il DANS `parent` (ou `parent` lui-même) ? Frontière de segment. */
export function isUnderPath(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  if (p === '') return false;
  // La frontière compte : sans le `/`, un dossier `dev` avalerait `dev-notes`
  // (revue Codex, 26/08).
  const isWin = /^[a-z]:\//i.test(c) || /^[a-z]:\//i.test(p);
  const cc = isWin ? c.toLowerCase() : c;
  const pp = isWin ? p.toLowerCase() : p;
  return cc === pp || cc.startsWith(pp + '/');
}

/** Un dossier attaché à un agent, tel que la dérivation en a besoin. */
export interface WorkspaceRef {
  label: string;
  path: string;
  isDevFolder: boolean;
}

/**
 * Résout un chemin brut d'édition en chemin ABSOLU slash-normalisé.
 *
 * Un chemin RELATIF est la forme Nodal : quand l'agent a plusieurs dossiers,
 * son premier segment est le LABEL du dossier visé (`notes/a.md` → le dossier
 * étiqueté `notes`). C'est une donnée, pas une énigme — la lire évite de
 * deviner (revue Codex, 26/08 : coller le chemin au seul dossier coché faisait
 * passer `vault/note.md` pour du développement).
 *
 * Sans label reconnu et avec un seul dossier, le chemin est relatif à sa
 * racine. Sinon : null, on ne devine pas.
 */
function resolveAbsoluteChangePath(rawPath: string, workspaces: WorkspaceRef[]): string | null {
  const p = normPath(rawPath.trim());
  if (p === '') return null;
  if (isAbsoluteChangePath(p)) return p;
  const rel = p.replace(/^\.\//, '');

  const [first, ...rest] = rel.split('/');
  // TOUS les dossiers, cochés ou non : reconnaître le label du coffre est
  // précisément ce qui permet de savoir que l'écriture tombe hors périmètre.
  const byLabel = workspaces.find((w) => w.label === first);
  if (byLabel && rest.length > 0) return `${normPath(byLabel.path)}/${rest.join('/')}`;

  if (workspaces.length === 1) return `${normPath(workspaces[0]!.path)}/${rel}`;

  // Plusieurs dossiers et aucun label reconnu : l'existence sur disque peut
  // encore trancher, sinon on renonce.
  const candidates = workspaces
    .map((w) => `${normPath(w.path)}/${rel}`)
    .filter(isAbsoluteChangePath);
  const existing = candidates.find((c) => {
    try {
      return fsExistsSync(c);
    } catch {
      return false;
    }
  });
  return existing ?? null;
}

/**
 * Manifestes de projet. Servent à UNE SEULE question, et uniquement à la
 * racine d'un dossier coché : ce dossier est-il lui-même un projet, ou un
 * conteneur de projets ?
 *
 * Ils ne servent PLUS à chercher un projet à tous les niveaux. Cette recherche
 * répondait « où commence le projet », mais elle décidait aussi, en pratique,
 * ce qui était du code — et c'est une devinette dont le produit ne veut plus
 * (décision Quentin 26/08). Elle rendait `outputs/calorie-counter/app` comme
 * projet, parce que le `index.html` était là ; désormais c'est `outputs`, et
 * c'est au skill « dev » de corriger le rangement à la source.
 */
const PROJECT_MARKERS = [
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

function hasProjectMarker(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((m) => fsExistsSync(`${dir}/${m}`));
  } catch {
    return false;
  }
}

/**
 * Le projet d'un fichier, dans un dossier COCHÉ « développement ».
 *
 * Une seule règle : **un projet est un enfant direct du dossier coché.**
 * Cocher `Documents/Dev` ne fait pas de `Dev` un projet — ses sous-dossiers en
 * sont, quelle que soit la profondeur du fichier édité :
 *
 *   Dev/calorie-counter/app/index.html  →  Dev/calorie-counter
 *   Dev/NodalAI/apps/web/src/page.tsx   →  Dev/NodalAI
 *
 * C'est aussi ce que le skill « dev » demande aux agents (« une app = un
 * dossier au premier niveau »), donc l'affichage et la consigne disent enfin
 * la même chose.
 *
 * SEULE exception, et elle est nécessaire : si le dossier coché porte
 * lui-même un manifeste, c'est LUI le projet. Sans ça, cocher directement un
 * dépôt afficherait `apps`, `packages` et `docs` comme trois projets. Une
 * seule vérification, à la racine du dossier coché — jamais de remontée.
 *
 * Un fichier posé à la racine même du dossier coché rend ce dossier.
 */
function projectUnderDevFolder(
  dir: string,
  devRoot: string,
  memo: Map<string, string | null>,
): string {
  const rootIsProject = memo.get(`root|${devRoot}`);
  let isProject: boolean;
  if (rootIsProject === undefined) {
    isProject = hasProjectMarker(devRoot);
    memo.set(`root|${devRoot}`, isProject ? devRoot : null);
  } else {
    isProject = rootIsProject !== null;
  }
  if (isProject) return devRoot;

  const isWin = /^[a-z]:\//i.test(dir);
  const a = isWin ? dir.toLowerCase() : dir;
  const b = isWin ? devRoot.toLowerCase() : devRoot;
  if (a === b || !a.startsWith(b + '/')) return devRoot;
  const child = dir.slice(devRoot.length + 1).split('/')[0];
  return child ? `${devRoot}/${child}` : devRoot;
}

/**
 * Le projet d'un pipeline, depuis les chemins BRUTS de ses éditions.
 *
 * `devFolders` : les dossiers que le propriétaire a cochés « développement ».
 * Une écriture HORS de ces dossiers ne produit aucun projet — c'est toute la
 * décision du 26/08. Le coffre Obsidian n'y est pas, donc il n'apparaît jamais,
 * même quand un agent développeur y travaille.
 *
 * Vote majoritaire quand les fichiers se répartissent sur plusieurs projets :
 * le projet affiché est celui où le gros du travail a eu lieu.
 */
export function deriveProjectRoot(
  rawPaths: string[],
  workspaces: WorkspaceRef[],
  memo: Map<string, string | null>,
): string | null {
  const roots = workspaces
    .filter((w) => w.isDevFolder)
    .map((w) => normPath(w.path))
    // Un dossier coché posé sur une RACINE DE DISQUE est ignoré : il
    // engloberait la machine entière, et la règle « enfant direct » en tirerait
    // des projets nommés `Users` ou `home`. Aucun projet vaut mieux qu'un
    // projet inventé.
    .filter((r) => r !== '' && !isDriveRoot(r))
    // Du plus long au plus court : un dossier coché NICHÉ dans un autre gagne,
    // sinon le parent avalerait l'enfant et le projet remonterait d'un cran.
    .sort((a, b) => b.length - a.length);
  if (roots.length === 0) return null;

  const votes = new Map<string, number>();
  for (const raw of rawPaths) {
    // Résolu contre TOUS les dossiers de l'agent, cochés ou non : c'est ce qui
    // permet de reconnaître `vault/note.md` comme une écriture dans le coffre
    // plutôt que de la coller au seul dossier coché.
    const abs = resolveAbsoluteChangePath(raw, workspaces);
    if (!abs) continue;
    const dir = abs.replace(/\/[^/]*$/, '');
    if (dir === '' || dir === abs) continue;

    const devRoot = roots.find((r) => isUnderPath(abs, r) && !samePath(abs, r));
    // Écriture hors de tout dossier de développement : rien.
    if (!devRoot) continue;

    const project = projectUnderDevFolder(dir, devRoot, memo);
    votes.set(project, (votes.get(project) ?? 0) + 1);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return winner !== null && !isDriveRoot(winner) ? winner : null;
}

/**
 * Ce chemin tombe-t-il dans l'un des dossiers cochés ?
 *
 * Sert à ne compter et n'afficher QUE les fichiers du périmètre : un pipeline
 * qualifié par une écriture dans un dossier coché ramenait sinon tout le reste
 * avec lui — le `vault/note.md` écrit au passage apparaissait dans la liste
 * des fichiers changés (revue Codex, 26/08).
 *
 * Un chemin RELATIF passe par la même résolution par LABEL que la dérivation
 * de projet. Le tenir pour « forcément dans le périmètre » était une devinette,
 * et elle faisait entrer le coffre.
 */
export function isInsideDevFolder(rawPath: string, workspaces: WorkspaceRef[]): boolean {
  const abs = resolveAbsoluteChangePath(rawPath, workspaces);
  if (!abs) return false;
  return workspaces
    .filter((w) => w.isDevFolder)
    .map((w) => normPath(w.path))
    .filter((r) => r !== '' && !isDriveRoot(r))
    .some((r) => isUnderPath(abs, r) && !samePath(abs, r));
}

/** `D:/APPS/NodalAI` → `NodalAI` — le nom d'affichage d'un projet. */
export function projectNameFromPath(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}

/**
 * Une racine de disque (`C:`, `C:/`, `/`) n'est JAMAIS un projet (revue P1 du
 * 25/08) : un workspace configuré sur `C:\` matcherait tout le disque et
 * produirait un « projet » nommé `Users`. Mieux vaut aucun projet qu'un projet
 * aberrant — la session retombe alors dans le tiroir « Other sessions ».
 */
export function isDriveRoot(p: string): boolean {
  // Les slashes de fin sont retirés d'abord, sinon `//` (et `C://`) passaient
  // à travers — c'est le jumeau runner de ce prédicat qui l'a révélé.
  const s = p.replace(/\/+$/, '');
  return s === '' || s === '/' || /^[a-z]:$/i.test(s);
}

/** Normalisation d'un chemin de workspace vers la forme projet (slashes, sans trailing). */
export function normalizeWorkspacePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Repli « Other sessions » (constat Quentin 25/08 : « c'est quoi ce
 * fourre-tout ? ») : une session sans AUCUN fichier ancrable (zéro édition,
 * ou chemins relatifs morts) retombe sur l'unique workspace de son agent
 * racine — sans ambiguïté possible. Un agent à 0 ou 2+ workspaces reste dans
 * le tiroir : on ne devine pas.
 */
export function fallbackProjectFromAgentWorkspaces(agentPaths: string[]): string | null {
  if (agentPaths.length !== 1) return null;
  return normalizeWorkspacePath(agentPaths[0]!);
}
