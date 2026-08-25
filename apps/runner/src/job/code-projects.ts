// job/code-projects.ts — les PROJETS de code de l'espace, pour le bloc
// `## Runtime` de chaque agent (décision Quentin 25/08).
//
// POURQUOI : trois sessions de suite ont montré la même panne — « modifie
// l'app calorie-counter » arrive à l'agent root, qui ne sait ni où elle vit
// ni à qui la confier. Il cherche à l'aveugle, échoue, et dans le pire cas
// annonce un travail qu'il n'a pas fait. Rien dans son contexte ne dit que
// cette app existe ni qu'elle appartient à l'équipe dev.
//
// Ce module dérive la liste (nom, chemin, détenteurs) depuis les éditions
// RÉELLES enregistrées, avec la même règle que l'onglet Code : la racine du
// projet est le plus haut dossier marqué (.git, package.json, index.html…)
// sous le workspace, sinon le sous-dossier de premier niveau. Rien n'est
// stocké : un projet naît de son activité, comme dans l'onglet.
//
// Le rendu final vit dans buildRuntimeBlock (packages/orchestration) — ce
// module ne fabrique QUE des données.

import { existsSync } from 'node:fs';
import {
  and,
  desc,
  eq,
  inArray,
  agentWorkspaces,
  agents,
  codeProjects,
  toolCalls,
} from '@nodal-agents/db';
import type { CodeProjectSummary } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';

// Depuis le 26/08, ce module ne juge plus rien : ni l'extension des fichiers,
// ni les skills de l'agent, ni une case sur le dossier. Il liste les dossiers
// attachés aux agents, et applique les DEUX gestes du propriétaire — le nom
// qu'il a choisi, et ce qu'il a masqué (`code_projects`, migration 0086).
//
// Même règle que l'onglet Code, ce qui est indispensable : ce module dit aux
// agents quels projets existent, l'onglet les montre au propriétaire, et un
// désaccord entre les deux ne se voit depuis aucun écran.

/** Outils dont l'input porte un chemin de fichier édité. */
const EDIT_TOOLS = [
  'cli:Edit',
  'cli:Write',
  'cli:MultiEdit',
  'cli:NotebookEdit',
  'file_edit',
  'file_write',
];

/** Marqueurs de racine de projet — mêmes conventions que l'onglet Code. */
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

/** Plafond de projets injectés — le bloc Runtime doit rester un repère, pas un annuaire. */
const MAX_PROJECTS = 12;
/** Fenêtre de scan des éditions récentes. */
const SCAN_LIMIT = 1500;

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const isAbsolute = (p: string): boolean => /^[a-z]:\//i.test(p) || p.startsWith('/');

function hasMarker(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((m) => existsSync(`${dir}/${m}`));
  } catch {
    return false;
  }
}

/**
 * Une racine de disque (`/`, `C:`, `C:/`) n'est jamais un workspace exploitable :
 * elle engloberait la machine entière, et le repli « sous-dossier de premier
 * niveau » en tirerait des projets nommés `Users` ou `home`.
 *
 * La garde vit des DEUX côtés (revue du 25/08) : l'onglet Code l'a
 * (apps/web/src/lib/code-projects.ts), le contexte injecté ne l'avait pas — le
 * prompt système annonçait donc à tous les agents un projet que l'interface
 * refusait d'afficher, avec ses détenteurs. Deux dérivations, deux vérités.
 */
export function isDriveRoot(p: string): boolean {
  const s = p.replace(/\/+$/, '');
  return s === '' || s === '/' || /^[a-z]:$/i.test(s);
}

function within(dir: string, root: string): boolean {
  const isWin = /^[a-z]:\//i.test(dir);
  const a = isWin ? dir.toLowerCase() : dir;
  const b = isWin ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + '/');
}

/**
 * Le projet d'un fichier, dans un dossier COCHÉ « développement ».
 *
 * JUMEAU de `projectUnderDevFolder` dans apps/web/src/lib/code-projects.ts —
 * les deux vues doivent répondre pareil, sous peine d'annoncer aux agents des
 * projets que l'onglet ne montre pas.
 *
 * Une seule règle : un projet est un ENFANT DIRECT du dossier coché, quelle
 * que soit la profondeur du fichier édité. Cocher `Dev` ne fait pas de `Dev`
 * un projet, ses sous-dossiers en sont. Seule exception, nécessaire : si le
 * dossier coché porte lui-même un manifeste, c'est LUI le projet — sinon
 * cocher directement un dépôt afficherait `apps`, `packages` et `docs` comme
 * trois projets.
 *
 * Mémoïsé : le manifeste du dossier coché est lu une fois par entité, pas une
 * fois par ligne scannée.
 */
function projectRootFor(absFile: string, devRoot: string, memo: Map<string, string>): string {
  const dir = absFile.replace(/\/[^/]*$/, '');
  const key = `${devRoot}|${dir}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const rootKey = `root|${devRoot}`;
  let rootIsProject = memo.get(rootKey);
  if (rootIsProject === undefined) {
    rootIsProject = hasMarker(devRoot) ? 'yes' : 'no';
    memo.set(rootKey, rootIsProject);
  }

  let result: string;
  if (rootIsProject === 'yes' || !within(dir, devRoot) || dir === devRoot) {
    result = devRoot;
  } else {
    const child = dir.slice(devRoot.length + 1).split('/')[0];
    result = child ? `${devRoot}/${child}` : devRoot;
  }
  memo.set(key, result);
  return result;
}

/**
 * Cache par entité (revue P1 du 25/08) : `getDeploymentContext` tourne à
 * CHAQUE job ET à chaque tour de chat. Un projet ne naît pas deux fois par
 * minute — 60 s de TTL suffisent, et le prix du scan est payé une fois.
 */
const PROJECTS_TTL_MS = 60_000;
const projectsCache = new Map<string, { at: number; value: CodeProjectSummary[] }>();

/**
 * Vide le cache — réservé aux tests.
 *
 * Sans ça, deux assertions successives sur la même entité lisent la même liste
 * mémoïsée : la seconde ne teste plus rien. Constaté en vérifiant par mutation
 * un test de filtrage qui passait toujours, filtre débranché (revue du 25/08).
 */
export function _resetProjectsCacheForTests(): void {
  projectsCache.clear();
}

/**
 * Les projets de code de l'entité, avec leurs détenteurs.
 *
 * Best-effort sur les INCIDENTS D'EXÉCUTION : une base momentanément
 * injoignable rend une liste vide et le bloc Runtime omet la section, plutôt
 * que de faire échouer un job pour une information de confort.
 *
 * PAS sur les BUGS : une ReferenceError ou une TypeError remonte et fait
 * échouer le job. Le contrat était « ne jette jamais », et il déguisait un
 * import oublié en « aucun projet » pendant qu'une suite de tests entière
 * restait verte (revue du 25/08).
 */
export async function listCodeProjectsForContext(
  db: RunnerDeps['db'],
  entityId: string,
): Promise<CodeProjectSummary[]> {
  const cached = projectsCache.get(entityId);
  if (cached && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.value;
  try {
    // Les dossiers attachés aux agents de l'espace, et qui les détient. Aucun
    // dossier attaché, aucun projet à annoncer.
    const wsRows = await db
      .select({
        agentId: agentWorkspaces.agentId,
        agentName: agents.name,
        path: agentWorkspaces.path,
      })
      .from(agentWorkspaces)
      .innerJoin(agents, eq(agents.id, agentWorkspaces.agentId))
      .where(eq(agents.entityId, entityId));
    if (wsRows.length === 0) return [];

    // Les deux gestes du propriétaire. Le MASQUAGE porte jusqu'ici : jusqu'au
    // 26/08 l'archivage n'était lu que par l'interface, si bien qu'un projet
    // rangé continuait d'être annoncé dans le prompt système de tous les
    // agents. Ranger quelque chose et continuer à en parler à tout le monde
    // n'avait pas de sens ; c'est la demande de Quentin, mot pour mot :
    // « que ça retire le dossier du contexte et de la mémoire des agents ».
    const projectRows = await db
      .select({
        projectPath: codeProjects.projectPath,
        displayName: codeProjects.displayName,
        hidden: codeProjects.hidden,
      })
      .from(codeProjects)
      .where(eq(codeProjects.entityId, entityId));
    // Clé insensible à la casse : sur Windows `C:\Dev` et `c:/dev` désignent le
    // même dossier, et un masquage ne doit pas dépendre de la façon dont le
    // chemin a été saisi.
    const projectKey = (p: string): string => norm(p).toLowerCase();
    const hiddenPaths = new Set(
      projectRows.filter((r) => r.hidden).map((r) => projectKey(r.projectPath)),
    );
    const namesByPath = new Map(
      projectRows
        .filter((r) => r.displayName !== null && r.displayName.trim() !== '')
        .map((r) => [projectKey(r.projectPath), r.displayName!.trim()]),
    );

    // Racines uniques, plus longues d'abord (un workspace niché gagne).
    const roots = Array.from(new Set(wsRows.map((r) => norm(r.path))))
      .filter((r) => !isDriveRoot(r))
      .sort((a, b) => b.length - a.length);
    if (roots.length === 0) return [];
    const ownersByRoot = new Map<string, Set<string>>();
    for (const r of wsRows) {
      const set = ownersByRoot.get(norm(r.path)) ?? new Set<string>();
      set.add(r.agentName);
      ownersByRoot.set(norm(r.path), set);
    }

    // Le scan n'est plus filtré par auteur : c'est le DOSSIER qui décide.
    // Une écriture hors des dossiers cochés ne trouvera aucune racine plus bas
    // et sera ignorée ; qui l'a faite n'entre pas dans le calcul.
    const rows = await db
      .select({
        toolInput: toolCalls.toolInput,
        toolOutput: toolCalls.toolOutput,
        createdAt: toolCalls.createdAt,
      })
      .from(toolCalls)
      .where(and(eq(toolCalls.entityId, entityId), inArray(toolCalls.toolName, EDIT_TOOLS)))
      .orderBy(desc(toolCalls.createdAt))
      .limit(SCAN_LIMIT);

    const rootMemo = new Map<string, string>();
    const existsMemo = new Map<string, boolean>();
    const existsCached = (p: string): boolean => {
      const hit = existsMemo.get(p);
      if (hit !== undefined) return hit;
      let ok = false;
      try {
        ok = existsSync(p);
      } catch {
        ok = false;
      }
      existsMemo.set(p, ok);
      return ok;
    };

    const byPath = new Map<string, { owners: Set<string>; lastActivityAt: string | null }>();
    for (const row of rows) {
      // Une écriture REFUSÉE n'a rien créé — même règle que l'onglet Code.
      const head = (row.toolOutput ?? '').slice(0, 400);
      if (head.includes('<tool_use_error>') || /^\s*\{"ok"\s*:\s*false\b/.test(head)) continue;

      const input = (row.toolInput ?? {}) as Record<string, unknown>;
      const raw =
        typeof input['file_path'] === 'string'
          ? input['file_path']
          : typeof input['notebook_path'] === 'string'
            ? input['notebook_path']
            : typeof input['path'] === 'string'
              ? input['path']
              : null;
      if (!raw) continue;

      const p = norm(raw.trim());
      // Résolution : absolu tel quel, sinon collé au workspace qui l'héberge.
      const candidates = isAbsolute(p) ? [p] : roots.map((r) => `${r}/${p.replace(/^\.\//, '')}`);
      const abs = candidates.find(existsCached);
      if (!abs) continue;

      const wsRoot = roots.find((r) => within(abs, r));
      if (!wsRoot) continue;

      const projectPath = projectRootFor(abs, wsRoot, rootMemo);
      // Masqué par le propriétaire : il ne doit apparaître nulle part, ni dans
      // la liste, ni dans le contexte des agents.
      if (hiddenPaths.has(projectKey(projectPath))) continue;
      const entry = byPath.get(projectPath) ?? {
        owners: new Set(ownersByRoot.get(wsRoot) ?? []),
        lastActivityAt: row.createdAt ? row.createdAt.toISOString() : null,
      };
      for (const o of ownersByRoot.get(wsRoot) ?? []) entry.owners.add(o);
      byPath.set(projectPath, entry);
    }

    const result = Array.from(byPath.entries())
      .sort((a, b) => (b[1].lastActivityAt ?? '').localeCompare(a[1].lastActivityAt ?? ''))
      .slice(0, MAX_PROJECTS)
      .map(([path, v]) => ({
        // Le nom choisi par le propriétaire l'emporte : les agents entendent
        // le projet comme lui l'appelle, sinon « modifie le portail client »
        // ne désignerait rien pour eux alors que l'onglet l'affiche ainsi.
        name: namesByPath.get(projectKey(path)) ?? path.split('/').filter(Boolean).pop() ?? path,
        path,
        owners: Array.from(v.owners).sort(),
        lastActivityAt: v.lastActivityAt,
      }));
    projectsCache.set(entityId, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    // Un BUG DE PROGRAMMATION n'est pas un incident d'exécution : il remonte.
    //
    // Ce filet best-effort existe pour qu'une base momentanément injoignable
    // ne fasse pas échouer un job — la liste des projets est du confort, pas du
    // fonctionnel. Il avalait aussi les ReferenceError et TypeError : une
    // colonne oubliée dans un import a rendu une liste vide pendant que toute
    // une suite de tests continuait de passer sous les yeux (revue du 25/08).
    // Un repli silencieux qui déguise un bug en « rien à afficher » est
    // exactement ce que l'invariant #4 interdit.
    if (err instanceof ReferenceError || err instanceof TypeError) throw err;
    console.warn(
      '[code-projects] listing failed (context will omit the section):',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
