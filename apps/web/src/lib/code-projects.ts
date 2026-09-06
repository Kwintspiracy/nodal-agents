// code-projects.ts — dérivation du PROJET d'un pipeline de code.
//
// Un projet n'est pas stocké : il naît de sa première activité, regroupe
// rétroactivement toutes les sessions qui touchent au même dossier, et
// disparaît quand le dossier disparaît. Seuls les deux gestes du propriétaire
// persistent en base — le nom qu'il choisit et ce qu'il masque (`code_projects`,
// migration 0086).
//
// Ce module ne DEVINE plus rien (décision Quentin 26/08). Six définitions du
// « vrai code » ont été essayées et écartées ; 0086 les liste. La règle qui
// reste tient en une phrase : un projet est un enfant direct d'un dossier
// attaché à un agent, sauf si ce dossier porte lui-même un manifeste — auquel
// cas c'est lui le projet.
//
// Module séparé d'actions.ts : un fichier 'use server' ne peut exporter que
// des fonctions async — ces helpers sync (et testables) doivent vivre ici.

import { existsSync as fsExistsSync } from 'node:fs';
import { isAbsolutePath, isWindowsPath, normalizePath } from '@nodal-agents/shared';

/** Chemin absolu ? (POSIX `/…`, Windows `C:/…` ou UNC `//srv/part`.) */
const isAbsoluteChangePath = isAbsolutePath;

/** Slash-normalisé, sans slash final. */
export const normPath = normalizePath;

/**
 * Le même dossier, écrit différemment ? `C:\Dev`, `c:/Dev` et `C:/Dev/` sont
 * la même chose sur Windows (revue Codex, 26/08).
 */
export function samePath(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return isWindowsPath(x) || isWindowsPath(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** `child` est-il DANS `parent` (ou `parent` lui-même) ? Frontière de segment. */
export function isUnderPath(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  if (p === '') return false;
  // La frontière compte : sans le `/`, un dossier `dev` avalerait `dev-notes`
  // (revue Codex, 26/08).
  const isWin = isWindowsPath(c) || isWindowsPath(p);
  const cc = isWin ? c.toLowerCase() : c;
  const pp = isWin ? p.toLowerCase() : p;
  return cc === pp || cc.startsWith(pp + '/');
}

/** Un dossier attaché à un agent, tel que la dérivation en a besoin. */
export interface WorkspaceRef {
  label: string;
  path: string;
  /**
   * Masqué de l'onglet Code par le propriétaire (0087).
   *
   * Le dossier reste un workspace : son LABEL sert toujours à résoudre les
   * chemins relatifs, et c'est indispensable — sans lui, `vault/note.md` ne
   * serait plus reconnu comme une écriture DANS le coffre et se recollerait au
   * premier autre dossier venu (constat P1 de la revue Codex sur 0085). Seule
   * la liste des RACINES DE PROJET l'ignore.
   */
  hiddenFromCode: boolean;
}

/**
 * Une écriture, avec de quoi la situer : le chemin brut ET les dossiers de
 * l'agent QUI L'A FAITE.
 *
 * Porter l'auteur est indispensable (revue Codex, 26/08). Un label n'est unique
 * que par AGENT : dans un pipeline délégué, l'orchestrateur et son worker ont
 * chacun un dossier étiqueté `workspace`. En mettant tous les dossiers du
 * pipeline dans le même sac, `workspace/src/a.ts` écrit par le worker se
 * résolvait contre le dossier de l'orchestrateur — le premier label trouvé
 * gagnait. Mauvais projet, mauvais décompte de fichiers, et rien à l'écran pour
 * le signaler : exactement le repli silencieux que l'invariant #4 interdit.
 */
export interface ChangeRef {
  /** Le chemin tel que l'outil l'a enregistré (absolu, ou relatif à un label). */
  rawPath: string;
  /** Les dossiers de l'agent auteur — la clé de lecture des chemins relatifs. */
  workspaces: WorkspaceRef[];
}

/**
 * Existence sur disque, mémoïsée.
 *
 * Le `memo` traverse toute une dérivation : les mêmes dossiers reviennent des
 * centaines de fois sur un scan d'éditions, et chacun ne doit coûter qu'un seul
 * appel système.
 */
function existsMemo(p: string, memo: Map<string, string | null>): boolean {
  const key = `exists|${p}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit !== null;
  let present = false;
  try {
    present = fsExistsSync(p);
  } catch {
    present = false;
  }
  memo.set(key, present ? p : null);
  return present;
}

/**
 * Résout un chemin brut d'édition en chemin ABSOLU slash-normalisé.
 *
 * Un chemin RELATIF est la forme Nodal : quand l'agent a plusieurs dossiers,
 * son premier segment est le LABEL du dossier visé (`notes/a.md` → le dossier
 * étiqueté `notes`). C'est une donnée, pas une énigme — la lire évite de
 * deviner.
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
 * racine d'un dossier attaché : ce dossier est-il lui-même un projet, ou un
 * conteneur de projets ?
 *
 * Ils ne servent PAS à chercher un projet à tous les niveaux. Cette recherche
 * répondait « où commence le projet », mais elle décidait aussi, en pratique,
 * ce qui était du code — la devinette dont le produit ne veut plus. Elle
 * rendait `outputs/calorie-counter/app` comme projet parce que le `index.html`
 * était là ; désormais c'est `outputs`, et c'est au skill « dev » de corriger
 * le rangement à la source.
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

function hasProjectMarker(dir: string, memo: Map<string, string | null>): boolean {
  return PROJECT_MARKERS.some((m) => existsMemo(`${dir}/${m}`, memo));
}

/**
 * Le projet d'un fichier, dans un dossier attaché à l'agent.
 *
 * Une seule règle : **un projet est un enfant direct du dossier attaché.**
 * Attacher `Documents/Dev` ne fait pas de `Dev` un projet — ses sous-dossiers
 * en sont, quelle que soit la profondeur du fichier édité :
 *
 *   Dev/calorie-counter/app/index.html  →  Dev/calorie-counter
 *   Dev/NodalAI/apps/web/src/page.tsx   →  Dev/NodalAI
 *
 * C'est aussi ce que le skill « dev » demande aux agents (« une app = un
 * dossier au premier niveau »), donc l'affichage et la consigne disent la même
 * chose.
 *
 * SEULE exception, et elle est nécessaire : si le dossier attaché porte
 * lui-même un manifeste, c'est LUI le projet. Sans ça, attacher directement un
 * dépôt afficherait `apps`, `packages` et `docs` comme trois projets. Une
 * seule vérification, à la racine du dossier attaché — jamais de remontée.
 *
 * Un fichier posé à la racine même du dossier attaché rend ce dossier.
 */
function projectUnderWorkspace(
  dir: string,
  wsRoot: string,
  memo: Map<string, string | null>,
): string {
  if (hasProjectMarker(wsRoot, memo)) return wsRoot;

  const isWin = isWindowsPath(dir) || isWindowsPath(wsRoot);
  const a = isWin ? dir.toLowerCase() : dir;
  const b = isWin ? wsRoot.toLowerCase() : wsRoot;
  if (a === b || !a.startsWith(b + '/')) return wsRoot;
  const child = dir.slice(wsRoot.length + 1).split('/')[0];
  return child ? `${wsRoot}/${child}` : wsRoot;
}

/**
 * Ce chemin tombe-t-il dans un dossier MASQUÉ ? (0087)
 *
 * Le test porte sur le SOUS-ARBRE, pas sur l'égalité (revue Codex, 26/08).
 * Retirer seulement la racine masquée de la liste laissait un dossier PARENT
 * visible ramasser ses écritures : `/data` attaché et visible, `/data/vault`
 * attaché et masqué, et une note du coffre ressortait comme projet `/data/vault`
 * — le masquage contourné par le haut.
 */
function isUnderHiddenWorkspace(abs: string, workspaces: WorkspaceRef[]): boolean {
  return workspaces
    .filter((w) => w.hiddenFromCode)
    .map((w) => normPath(w.path))
    .filter((r) => r !== '')
    .some((r) => isUnderPath(abs, r));
}

/**
 * Les racines exploitables d'un agent : ses dossiers, les plus profonds d'abord.
 *
 * Les dossiers masqués Y RESTENT, délibérément. C'est le tri par longueur qui
 * fait le travail : un coffre masqué niché sous un dossier suivi gagne le
 * match, et le projet qu'il produit est ensuite écarté parce qu'il tombe sous
 * une racine masquée. En le retirant d'ici, le parent visible l'aurait ramassé.
 */
function workspaceRoots(workspaces: WorkspaceRef[]): string[] {
  return (
    workspaces
      .map((w) => normPath(w.path))
      // Un dossier posé sur une RACINE DE DISQUE est ignoré : il engloberait la
      // machine entière, et la règle « enfant direct » en tirerait des projets
      // nommés `Users` ou `home`. Aucun projet vaut mieux qu'un projet inventé.
      .filter((r) => r !== '' && !isDriveRoot(r))
      // Du plus long au plus court : un dossier NICHÉ dans un autre gagne,
      // sinon le parent avalerait l'enfant et le projet remonterait d'un cran.
      .sort((a, b) => b.length - a.length)
  );
}

/**
 * Le projet d'un pipeline, depuis les chemins BRUTS de ses éditions.
 *
 * Vote majoritaire quand les fichiers se répartissent sur plusieurs projets :
 * le projet affiché est celui où le gros du travail a eu lieu.
 *
 * Un projet dont le DOSSIER N'EXISTE PLUS n'est pas rendu. Constat de Quentin
 * (26/08) : « des dossiers qui ont été supprimés apparaissent malgré tout dans
 * l'onglet code ». Les éditions, elles, restent en base pour toujours — sans
 * cette vérification, un projet supprimé il y a six mois reste dans la liste,
 * et il n'existe aucun geste pour l'en sortir. Le contexte injecté aux agents
 * faisait déjà ce contrôle : les deux vues étaient en désaccord, et c'est
 * l'interface qui avait tort.
 */
export function deriveProjectRoot(
  changes: ChangeRef[],
  /**
   * Les dossiers de TOUT le pipeline. Ils servent à savoir si le fichier tombe
   * dans le périmètre — jamais à résoudre un chemin relatif, ce que seuls les
   * dossiers de l'auteur peuvent faire sans deviner.
   *
   * La distinction compte pour une délégation : le worker écrit, le dossier
   * appartient au lead. Le fichier est bien du pipeline.
   */
  pipelineWorkspaces: WorkspaceRef[],
  memo: Map<string, string | null>,
): string | null {
  const roots = workspaceRoots(pipelineWorkspaces);
  if (roots.length === 0) return null;

  const votes = new Map<string, number>();
  for (const change of changes) {
    const abs = resolveAbsoluteChangePath(change.rawPath, change.workspaces);
    if (!abs) continue;
    const dir = abs.replace(/\/[^/]*$/, '');
    if (dir === '' || dir === abs) continue;

    const wsRoot = roots.find((r) => isUnderPath(abs, r) && !samePath(abs, r));
    // Écriture hors de tout dossier attaché : on ne sait pas la rattacher.
    if (!wsRoot) continue;

    const project = projectUnderWorkspace(dir, wsRoot, memo);
    // Masqué par le propriétaire, à n'importe quel niveau au-dessus (0087).
    if (isUnderHiddenWorkspace(project, pipelineWorkspaces)) continue;
    if (!existsMemo(project, memo)) continue;
    votes.set(project, (votes.get(project) ?? 0) + 1);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return winner !== null && !isDriveRoot(winner) ? winner : null;
}

/**
 * Ce chemin tombe-t-il dans l'un des dossiers attachés à l'agent ?
 *
 * Sert à n'afficher que les fichiers rattachables : un pipeline ramenait sinon
 * avec lui des chemins qu'aucun dossier ne couvre (revue Codex, 26/08).
 *
 * Un chemin RELATIF passe par la même résolution par LABEL que la dérivation
 * de projet — le tenir pour « forcément dedans » serait une devinette.
 *
 * L'existence n'est PAS vérifiée ici : un fichier supprimé au cours du travail
 * a bien été édité, et son changement appartient à l'historique de la session.
 * C'est le DOSSIER DE PROJET dont la disparition efface la ligne.
 */
export function isInsideWorkspace(change: ChangeRef, pipelineWorkspaces: WorkspaceRef[]): boolean {
  const abs = resolveAbsoluteChangePath(change.rawPath, change.workspaces);
  if (!abs) return false;
  // Un fichier d'un dossier masqué n'est pas comptable non plus : il n'a aucune
  // ligne où s'afficher.
  if (isUnderHiddenWorkspace(abs, pipelineWorkspaces)) return false;
  return workspaceRoots(pipelineWorkspaces).some((r) => isUnderPath(abs, r) && !samePath(abs, r));
}

/**
 * La forme ABSOLUE d'une écriture, ou null si on ne sait pas la situer.
 *
 * Exposée pour la CANONICALISATION (revue Codex, 26/08). Dès qu'un agent a
 * plusieurs dossiers, les outils Nodal enregistrent `label/chemin` — et
 * `canonicalChangePath` ne sait retirer un préfixe que d'un chemin ABSOLU.
 * `dev/src/a.ts` en ressortait donc tel quel, pendant que la même édition faite
 * par une CLI, elle absolue, devenait `src/a.ts` : deux clés pour un seul
 * fichier, compté deux fois dans le panneau des changements.
 *
 * C'est exactement le bug que `canonicalChangePath` existe pour fermer (job
 * cbdbfc6c, 20/08), rouvert par la forme à label.
 */
export function resolveChangePath(change: ChangeRef): string | null {
  return resolveAbsoluteChangePath(change.rawPath, change.workspaces);
}

/** `D:/APPS/NodalAI` → `NodalAI` — le nom d'affichage par défaut d'un projet. */
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
 *
 * Le dossier doit exister, comme partout ailleurs : un workspace configuré sur
 * un dossier supprimé ne fabrique pas un projet fantôme.
 */
export function fallbackProjectFromAgentWorkspaces(
  agentPaths: string[],
  memo?: Map<string, string | null>,
): string | null {
  if (agentPaths.length !== 1) return null;
  const p = normalizeWorkspacePath(agentPaths[0]!);
  if (p === '' || isDriveRoot(p)) return null;
  if (memo && !existsMemo(p, memo)) return null;
  return p;
}
