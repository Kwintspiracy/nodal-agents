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
  agentSkills,
  agentSkillAssignments,
  agentJobs,
  toolCalls,
} from '@nodal-agents/db';
import type { CodeProjectSummary } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';

/**
 * Les skills qui font d'un agent un membre de l'équipe de dev — même liste que
 * l'onglet Code (`DEV_TEAM_SKILL_SLUGS` dans apps/web/src/lib/actions.ts).
 *
 * Les deux vues DOIVENT s'accorder : ce module dit aux agents quels projets
 * existent, l'onglet les montre au propriétaire. Sans ce filtre, le prompt
 * système annoncerait à tous les agents des projets que l'onglet ne montre
 * plus — un coffre de notes, des workflows d'images — avec leurs détenteurs,
 * et le désaccord serait invisible depuis l'interface.
 */
const DEV_TEAM_SKILL_SLUGS = ['dev', 'code-review'];

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
 * Profondeur de remontée des délégations. L'invariant #8 plafonne les chaînes
 * à 3 niveaux ; la marge absorbe une donnée abîmée sans jamais boucler.
 */
const MAX_ANCESTOR_DEPTH = 8;

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
    // Les agents DÉVELOPPEURS de l'entité. Un projet de code naît du travail
    // d'un développeur, pas de n'importe quelle écriture de fichier : c'est la
    // même règle d'identité que l'onglet Code, et elle doit valoir des deux
    // côtés sous peine d'annoncer aux agents des projets que le propriétaire
    // ne voit pas.
    const devTeamRows = await db
      .select({ agentId: agentSkillAssignments.agentId })
      .from(agentSkillAssignments)
      .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
      .where(
        and(
          eq(agentSkillAssignments.entityId, entityId),
          inArray(agentSkills.slug, DEV_TEAM_SKILL_SLUGS),
          // Le skill du catalogue, pas un homonyme créé par l'utilisateur.
          eq(agentSkills.createdBy, 'system'),
        ),
      );
    const devTeam = new Set(devTeamRows.map((r) => r.agentId));
    if (devTeam.size === 0) return [];

    // Les workspaces des DÉVELOPPEURS — la carte « qui possède quoi ».
    const wsRows = (
      await db
        .select({
          agentId: agentWorkspaces.agentId,
          agentName: agents.name,
          path: agentWorkspaces.path,
        })
        .from(agentWorkspaces)
        .innerJoin(agents, eq(agents.id, agentWorkspaces.agentId))
        .where(eq(agents.entityId, entityId))
    ).filter((r) => devTeam.has(r.agentId));
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

    // Le scan est filtré par l'AUTEUR de l'écriture, pas seulement par le
    // workspace (revue du 25/08, second tour).
    //
    // Filtrer les seuls workspaces suffisait tant qu'ils étaient disjoints, et
    // se retournait dans le cas NICHÉ : un non-développeur dont le workspace
    // (`D:/work/notes`) vit à l'intérieur de celui d'un développeur
    // (`D:/work`). Avant le filtre, la racine la plus longue gagnait et son
    // écriture restait chez lui ; après, sa racine disparaît de la liste et la
    // même écriture retombe dans le workspace du développeur — fabriquant un
    // « projet » de notes ATTRIBUÉ au développeur, annoncé dans le prompt de
    // tous les agents, et introuvable dans l'onglet Code. Le filtre aggravait
    // ce qu'il devait corriger.
    //
    // La jointure sur le job ferme les deux à la fois : l'écriture d'un
    // non-développeur ne crée ni ne rafraîchit plus aucun projet, où qu'elle
    // tombe.
    const rows = await db
      .select({
        jobId: toolCalls.jobId,
        toolInput: toolCalls.toolInput,
        toolOutput: toolCalls.toolOutput,
        createdAt: toolCalls.createdAt,
        authorId: agentJobs.agentId,
        parentJobId: agentJobs.parentJobId,
      })
      .from(toolCalls)
      .innerJoin(agentJobs, eq(agentJobs.id, toolCalls.jobId))
      .where(and(eq(toolCalls.entityId, entityId), inArray(toolCalls.toolName, EDIT_TOOLS)))
      .orderBy(desc(toolCalls.createdAt))
      .limit(SCAN_LIMIT);

    // La CHAÎNE, pas seulement l'auteur direct (revue du 25/08, troisième
    // tour). Juger le seul émetteur laissait les deux vues appliquer des règles
    // différentes : quand un développeur délègue à un worker qui ne porte pas
    // encore le skill, l'onglet Code montre le pipeline (il regarde toute la
    // chaîne) pendant que ce module omettait le projet (il ne regardait que
    // l'auteur). Sous-annoncer est le bon sens de l'erreur, mais deux règles
    // pour une même question restent deux vérités — et c'est exactement ce que
    // cette PR existait pour supprimer.
    const parentOfJob = new Map<string, string | null>();
    const agentOfJob = new Map<string, string>();
    for (const r of rows) {
      if (!r.jobId) continue;
      parentOfJob.set(r.jobId, r.parentJobId);
      if (r.authorId) agentOfJob.set(r.jobId, r.authorId);
    }
    // Les ancêtres, niveau par niveau — bornés par la profondeur de délégation.
    let toResolve = Array.from(
      new Set(
        rows
          .map((r) => r.parentJobId)
          .filter((id): id is string => id !== null && !agentOfJob.has(id)),
      ),
    );
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && toResolve.length > 0; depth++) {
      const ancestors = await db
        .select({
          id: agentJobs.id,
          parentJobId: agentJobs.parentJobId,
          agentId: agentJobs.agentId,
        })
        .from(agentJobs)
        .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, toResolve)));
      for (const a of ancestors) {
        parentOfJob.set(a.id, a.parentJobId);
        if (a.agentId) agentOfJob.set(a.id, a.agentId);
      }
      toResolve = Array.from(
        new Set(
          ancestors
            .map((a) => a.parentJobId)
            .filter((id): id is string => id !== null && !parentOfJob.has(id)),
        ),
      );
    }

    /** Un membre de l'équipe de dev figure-t-il dans la chaîne de ce job ? */
    const chainHasDev = (jobId: string): boolean => {
      let cursor: string | null = jobId;
      for (let hop = 0; hop <= MAX_ANCESTOR_DEPTH && cursor; hop++) {
        const agent = agentOfJob.get(cursor);
        if (agent && devTeam.has(agent)) return true;
        cursor = parentOfJob.get(cursor) ?? null;
      }
      return false;
    };

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
      // L'écriture d'un non-développeur ne fait naître aucun projet, où
      // qu'elle tombe — y compris dans le workspace d'un développeur. Sauf si
      // un développeur est ailleurs dans la chaîne : il a délégué, le travail
      // est le sien.
      if (!row.jobId || !chainHasDev(row.jobId)) continue;

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
