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
import { and, desc, eq, inArray, agentWorkspaces, agents, toolCalls } from '@nodal-agents/db';
import type { CodeProjectSummary } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';

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
 * Racine de projet d'un fichier : plus haut dossier marqué sous le workspace,
 * sinon 1er niveau. MÉMOÏSÉ par dossier (revue P1 du 25/08, finding bloquant) :
 * sans cache, chaque ligne scannée refaisait jusqu'à 24 remontées × 9 marqueurs
 * d'`existsSync` synchrones — jusqu'à ~324 000 accès disque par job, event
 * loop du runner gelé plusieurs secondes.
 */
function projectRootFor(absFile: string, wsRoot: string, memo: Map<string, string>): string {
  const dir = absFile.replace(/\/[^/]*$/, '');
  const key = `${wsRoot}|${dir}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let topmost: string | null = null;
  let cur = dir;
  for (let hops = 0; hops < 24 && cur && within(cur, wsRoot); hops++) {
    if (hasMarker(cur)) topmost = cur;
    const parent = cur.replace(/\/[^/]*$/, '');
    if (parent === cur || parent === '' || /^[a-z]:$/i.test(parent)) break;
    cur = parent;
  }
  let result: string;
  if (topmost) result = topmost;
  else if (!within(dir, wsRoot) || dir === wsRoot) result = wsRoot;
  else {
    const child = dir.slice(wsRoot.length + 1).split('/')[0];
    result = child ? `${wsRoot}/${child}` : wsRoot;
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
 * Les projets de code de l'entité, avec leurs détenteurs. Best-effort : toute
 * erreur rend une liste vide (le bloc Runtime omet alors la section) — jamais
 * une exception qui ferait échouer un job.
 */
export async function listCodeProjectsForContext(
  db: RunnerDeps['db'],
  entityId: string,
): Promise<CodeProjectSummary[]> {
  const cached = projectsCache.get(entityId);
  if (cached && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.value;
  try {
    // Les workspaces de l'entité, par agent — la carte « qui possède quoi ».
    const wsRows = await db
      .select({ agentName: agents.name, path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .innerJoin(agents, eq(agents.id, agentWorkspaces.agentId))
      .where(eq(agents.entityId, entityId));
    if (wsRows.length === 0) return [];

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
        name: path.split('/').filter(Boolean).pop() ?? path,
        path,
        owners: Array.from(v.owners).sort(),
        lastActivityAt: v.lastActivityAt,
      }));
    projectsCache.set(entityId, { at: Date.now(), value: result });
    return result;
  } catch (err) {
    console.warn(
      '[code-projects] listing failed (context will omit the section):',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
