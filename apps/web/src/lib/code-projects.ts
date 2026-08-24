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

/**
 * Résout un chemin brut d'édition en chemin ABSOLU slash-normalisé. Un chemin
 * relatif (forme Nodal, workspace-relative) est testé contre chaque workspace
 * — l'existence sur disque tranche l'ambiguïté ; fichier disparu et plusieurs
 * workspaces → null (on ne devine pas).
 */
function resolveAbsoluteChangePath(rawPath: string, workspaceRoots: string[]): string | null {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(rawPath.trim());
  if (p === '') return null;
  if (isAbsoluteChangePath(p)) return p;
  const rel = p.replace(/^\.\//, '');
  const candidates = workspaceRoots.map((r) => `${norm(r)}/${rel}`).filter(isAbsoluteChangePath);
  const existing = candidates.find((c) => {
    try {
      return fsExistsSync(c);
    } catch {
      return false;
    }
  });
  if (existing) return existing;
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Remonte de `dir` vers la racine du dépôt git (le premier dossier contenant
 * `.git`). Mémoïsé par requête — chaque dossier visité, trouvé ou non, est
 * mis en cache pour tous les chemins suivants du même écran.
 *
 * `stopAt` : frontière HAUTE de la remontée — le workspace qui contient le
 * fichier. Sans elle, un fichier d'un dossier non-versionné remontait
 * jusqu'à un repo fortuit AU-DESSUS du workspace (attrapé par le test : un
 * `.git` dans le home de l'utilisateur transformait tout en un seul projet).
 * Le projet ne peut jamais être plus large que le workspace.
 */
function findGitRoot(
  dir: string,
  memo: Map<string, string | null>,
  stopAt: string | null,
): string | null {
  const inBounds = (d: string): boolean => {
    if (!stopAt) return true;
    const isWin = /^[a-z]:\//i.test(d);
    const a = isWin ? d.toLowerCase() : d;
    const b = isWin ? stopAt.toLowerCase() : stopAt;
    return a === b || a.startsWith(b + '/');
  };
  const key = (d: string) => `${stopAt ?? ''}|${d}`;
  const visited: string[] = [];
  let cur = dir;
  for (let hops = 0; hops < 24 && cur && inBounds(cur); hops++) {
    const cached = memo.get(key(cur));
    if (cached !== undefined) {
      for (const v of visited) memo.set(key(v), cached);
      return cached;
    }
    visited.push(cur);
    try {
      if (fsExistsSync(`${cur}/.git`)) {
        for (const v of visited) memo.set(key(v), cur);
        return cur;
      }
    } catch {
      break;
    }
    const parent = cur.replace(/\/[^/]*$/, '');
    // Racine atteinte : '' (POSIX) ou 'c:' (Windows) — pas de repo au-dessus.
    if (parent === cur || parent === '' || /^[a-z]:$/i.test(parent)) break;
    cur = parent;
  }
  for (const v of visited) memo.set(key(v), null);
  return null;
}

/**
 * La racine de projet d'un pipeline, depuis les chemins BRUTS de ses éditions.
 * Vote majoritaire quand les fichiers se répartissent sur plusieurs repos —
 * le projet affiché est celui où le gros du travail a eu lieu.
 */
export function deriveProjectRoot(
  rawPaths: string[],
  workspaceRoots: string[],
  gitMemo: Map<string, string | null>,
): string | null {
  const gitVotes = new Map<string, number>();
  const wsVotes = new Map<string, number>();
  for (const raw of rawPaths) {
    const abs = resolveAbsoluteChangePath(raw, workspaceRoots);
    if (!abs) continue;
    const dir = abs.replace(/\/[^/]*$/, '');
    if (dir === '' || dir === abs) continue;
    // Le workspace qui contient le fichier — repli de groupement ET frontière
    // haute de la remontée git (workspaceRoots est trié du plus long au plus
    // court, donc le premier match est le plus spécifique).
    const isWin = /^[a-z]:\//i.test(abs);
    let wsRoot: string | null = null;
    for (const root of workspaceRoots) {
      const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (r === '') continue;
      const matches = isWin
        ? abs.toLowerCase().startsWith(r.toLowerCase() + '/')
        : abs.startsWith(r + '/');
      if (matches) {
        wsRoot = r;
        break;
      }
    }
    const git = findGitRoot(dir, gitMemo, wsRoot);
    if (git) {
      gitVotes.set(git, (gitVotes.get(git) ?? 0) + 1);
      continue;
    }
    if (wsRoot) wsVotes.set(wsRoot, (wsVotes.get(wsRoot) ?? 0) + 1);
  }
  const top = (m: Map<string, number>): string | null =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return top(gitVotes) ?? top(wsVotes);
}

/** `D:/APPS/NodalAI` → `NodalAI` — le nom d'affichage d'un projet. */
export function projectNameFromPath(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}
