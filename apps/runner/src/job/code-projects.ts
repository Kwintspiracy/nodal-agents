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
// RÉELLES enregistrées, avec la même règle que l'onglet Code : un projet est
// un enfant direct d'un dossier attaché, sauf si ce dossier porte lui-même un
// manifeste — auquel cas c'est lui le projet. Rien n'est stocké : un projet
// naît de son activité, comme dans l'onglet.
//
// Le rendu final vit dans buildRuntimeBlock (packages/orchestration) — ce
// module ne fabrique QUE des données.

import { existsSync } from 'node:fs';
import {
  and,
  desc,
  eq,
  inArray,
  agentJobs,
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
  // Le nom que porte une écriture d'un agent en runtime CODEX — même raison que
  // dans l'onglet Code, et le même besoin d'accord entre les deux vues.
  'cli:file_change',
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

/**
 * Chemin Windows — jumeau de `apps/web/src/lib/project-key.ts`.
 *
 * DEUX formes (revue Codex, 26/08) : la lettre de lecteur, et le partage réseau
 * UNC que la normalisation rend `//serveur/part`. Les workspaces acceptent les
 * deux ; ne reconnaître que la première rendait un partage Windows sensible à
 * la casse, et ses écritures pouvaient être écartées du contexte.
 */
const isWindowsPath = (p: string): boolean => /^[a-z]:\//i.test(p) || p.startsWith('//');

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

/**
 * LA clé d'identité d'un projet — jumeau de `apps/web/src/lib/project-key.ts`.
 *
 * La casse n'est repliée QUE pour les chemins Windows (revue Codex, 26/08) :
 * sur un système sensible à la casse, `/srv/App` et `/srv/app` sont deux
 * dossiers différents, et les confondre ferait qu'en masquer un masquerait
 * l'autre.
 *
 * Les deux copies doivent répondre pareil : l'une décide ce que l'interface
 * montre, l'autre ce que les agents entendent, et un désaccord entre elles ne
 * se voit depuis aucun écran.
 */
export function projectKey(p: string): string {
  const s = norm(p);
  return isWindowsPath(s) ? s.toLowerCase() : s;
}

function within(dir: string, root: string): boolean {
  const isWin = isWindowsPath(dir) || isWindowsPath(root);
  const a = isWin ? dir.toLowerCase() : dir;
  const b = isWin ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + '/');
}

/**
 * Le projet d'un fichier, dans un dossier attaché à un agent.
 *
 * JUMEAU de `projectUnderWorkspace` dans apps/web/src/lib/code-projects.ts —
 * les deux vues doivent répondre pareil, sous peine d'annoncer aux agents des
 * projets que l'onglet ne montre pas.
 *
 * Une seule règle : un projet est un ENFANT DIRECT du dossier attaché, quelle
 * que soit la profondeur du fichier édité. Attacher `Dev` ne fait pas de `Dev`
 * un projet, ses sous-dossiers en sont. Seule exception, nécessaire : si le
 * dossier attaché porte lui-même un manifeste, c'est LUI le projet — sinon
 * attacher directement un dépôt afficherait `apps`, `packages` et `docs` comme
 * trois projets.
 *
 * Mémoïsé : le manifeste du dossier attaché est lu une fois par entité, pas une
 * fois par ligne scannée.
 */
function projectRootFor(absFile: string, wsRoot: string, memo: Map<string, string>): string {
  const dir = absFile.replace(/\/[^/]*$/, '');
  const key = `${wsRoot}|${dir}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const rootKey = `root|${wsRoot}`;
  let rootIsProject = memo.get(rootKey);
  if (rootIsProject === undefined) {
    rootIsProject = hasMarker(wsRoot) ? 'yes' : 'no';
    memo.set(rootKey, rootIsProject);
  }

  let result: string;
  if (rootIsProject === 'yes' || !within(dir, wsRoot) || dir === wsRoot) {
    result = wsRoot;
  } else {
    const child = dir.slice(wsRoot.length + 1).split('/')[0];
    result = child ? `${wsRoot}/${child}` : wsRoot;
  }
  memo.set(key, result);
  return result;
}

/**
 * Un chemin brut d'édition → sa forme ABSOLUE, ou null.
 *
 * Même ordre de règles que `resolveAbsoluteChangePath` de l'onglet Code, et
 * ce n'est pas un hasard : les deux vues doivent situer un fichier au même
 * endroit, sous peine d'annoncer aux agents des projets que l'interface ne
 * montre pas (ou l'inverse).
 *
 *   1. absolu           → tel quel
 *   2. `label/reste`    → le dossier de l'auteur qui porte ce label. C'est la
 *                         forme que les outils Nodal enregistrent dès qu'un
 *                         agent a plus d'un dossier ; la lire est une lecture
 *                         de donnée, pas une devinette.
 *   3. un seul dossier  → relatif à sa racine
 *   4. sinon            → l'existence sur disque tranche, et si rien
 *                         n'existe, on renonce plutôt que de choisir au hasard
 *
 * Les trois premiers cas sont DÉTERMINISTES : ils ne consultent pas le disque
 * (revue Codex, 26/08). Exiger que le fichier existe encore effaçait un projet
 * bien vivant dès qu'un fichier édité avait été supprimé depuis — un renommage,
 * un refactor, un `.tmp` nettoyé. L'onglet Code, lui, garde cette histoire :
 * ce qu'il vérifie, c'est le DOSSIER DE PROJET, pas chaque fichier. Les deux
 * vues doivent juger pareil.
 *
 * Le disque n'est consulté qu'au cas 4, où il n'y a rien d'autre pour trancher.
 */
function resolveScannedPath(
  p: string,
  authorWorkspaces: Array<{ label: string; path: string }>,
  roots: string[],
  exists: (path: string) => boolean,
): string | null {
  if (isAbsolute(p)) return p;
  const rel = p.replace(/^\.\//, '');

  const [first, ...rest] = rel.split('/');
  const byLabel = authorWorkspaces.find((w) => w.label === first);
  if (byLabel && rest.length > 0) return `${byLabel.path}/${rest.join('/')}`;

  if (authorWorkspaces.length === 1) return `${authorWorkspaces[0]!.path}/${rel}`;

  // Plusieurs dossiers et aucun label reconnu : l'existence tranche — mais
  // CHEZ L'AUTEUR (revue Codex, 26/08). Chercher parmi toutes les racines de
  // l'espace attribuait l'écriture au projet d'un agent qui n'y est pour rien,
  // dès qu'un chemin homonyme existait ailleurs et arrivait plus tôt dans
  // l'ordre. Le jumeau web ne cherche que chez l'auteur ; deviner ici, c'est
  // à la fois un repli malin (invariant #4) et un désaccord entre les vues.
  const candidates = authorWorkspaces.length > 0 ? authorWorkspaces.map((w) => w.path) : roots;
  return candidates.map((r) => `${r}/${rel}`).find(exists) ?? null;
}

/**
 * Les RACINES exploitables d'un espace, et qui détient chacune.
 *
 * Dédupliquées par `projectKey`, pas par texte brut (revue Codex, 26/08). Deux
 * agents attachant le MÊME dossier Windows avec des casses différentes —
 * `C:/Dev` et `c:/dev` — produisaient deux racines ; `within` les fait toutes
 * deux matcher, donc la première gagnait le rattachement, mais les détenteurs
 * étaient indexés sur leur propre graphie. Résultat : un projet annoncé aux
 * agents avec la MOITIÉ de ses détenteurs, sans que rien ne le signale.
 *
 * Une seule graphie survit pour l'affichage — la première rencontrée — et c'est
 * la clé normalisée qui agrège.
 *
 * Fonction PURE, et extraite pour ça : testée sur `C:/Dev` vs `c:/dev` sans
 * dépendre du système de fichiers de l'hôte. Un test qui fabriquerait deux
 * dossiers ne différant que par la casse prouverait deux choses opposées selon
 * qu'il tourne sur Windows (même dossier) ou sur la CI Linux (deux dossiers).
 */
export function canonicalRoots(wsRows: ReadonlyArray<{ path: string; agentName: string }>): {
  roots: string[];
  ownersByRoot: Map<string, Set<string>>;
} {
  const parCle = new Map<string, string>();
  for (const r of wsRows) {
    const p = norm(r.path);
    if (isDriveRoot(p)) continue;
    if (!parCle.has(projectKey(p))) parCle.set(projectKey(p), p);
  }

  const ownersByRoot = new Map<string, Set<string>>();
  for (const r of wsRows) {
    const affiche = parCle.get(projectKey(norm(r.path)));
    if (!affiche) continue;
    const set = ownersByRoot.get(affiche) ?? new Set<string>();
    set.add(r.agentName);
    ownersByRoot.set(affiche, set);
  }

  // Plus longues d'abord : un workspace niché gagne sur son parent.
  return { roots: Array.from(parCle.values()).sort((a, b) => b.length - a.length), ownersByRoot };
}

/** Une écriture retenue par le scan, déjà résolue jusqu'à son dossier de projet. */
export interface ScannedWrite {
  projectPath: string;
  owners: readonly string[];
  /** ISO, ou `null` si la ligne n'a pas de date. */
  at: string | null;
}

/**
 * Regrouper les écritures en projets, par IDENTITÉ et non par chemin brut.
 *
 * Sous Windows, `C:/Dev/App/src/a.ts` et `C:/Dev/app/src/b.ts` sont le MÊME
 * projet. Le scan groupait sur le chemin littéral : le projet apparaissait deux
 * fois dans le contexte injecté et mangeait deux places sur les douze, alors
 * que l'onglet Code, lui, ne le montrait qu'une fois — le désaccord entre les
 * deux vues que ce module existe pour éviter (revue Codex, 27/08).
 *
 * `writes` est attendu de la plus RÉCENTE à la plus ancienne (l'ordre de la
 * requête) : l'orthographe et la date retenues sont donc celles de la dernière
 * écriture. Fonction pure, pour être prouvable sans dépendre de la casse du
 * système de fichiers du testeur.
 */
export function groupScannedWrites(writes: readonly ScannedWrite[]): RawProject[] {
  const byKey = new Map<string, { path: string; owners: Set<string>; at: string | null }>();
  for (const w of writes) {
    const cle = projectKey(w.projectPath);
    const entry = byKey.get(cle) ?? { path: w.projectPath, owners: new Set<string>(), at: w.at };
    for (const o of w.owners) entry.owners.add(o);
    byKey.set(cle, entry);
  }
  // Trié par activité, JAMAIS tronqué ici : le plafond s'applique après le
  // masquage, sinon ranger un projet ferait un trou dans les douze au lieu de
  // laisser la place au suivant.
  return Array.from(byKey.values())
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .map((v) => ({
      path: v.path,
      owners: Array.from(v.owners).sort(),
      lastActivityAt: v.at,
    }));
}

/** Un projet tel que le SCAN le voit : sans nom choisi, sans masquage appliqué. */
export interface RawProject {
  path: string;
  owners: string[];
  lastActivityAt: string | null;
}

/**
 * Cache par entité (revue P1 du 25/08) : `getDeploymentContext` tourne à
 * CHAQUE job ET à chaque tour de chat. Un projet ne naît pas deux fois par
 * minute — 60 s de TTL suffisent, et le prix du scan est payé une fois.
 *
 * Le cache ne porte QUE le scan (revue Codex, 26/08). Il portait aussi les
 * préférences, si bien que masquer un projet le laissait annoncé aux agents
 * pendant une minute — alors que l'interface confirmait « vos agents ne le
 * voient plus ». Un message vrai à l'écran et faux dans les faits est pire que
 * pas de message. Les préférences sont donc relues à CHAQUE appel : c'est une
 * lecture indexée sur une table qui compte une ligne par projet rangé, contre
 * 1500 tool_calls et autant de vérifications disque pour le scan.
 */
const PROJECTS_TTL_MS = 60_000;
const projectsCache = new Map<string, { at: number; value: RawProject[] }>();

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
  try {
    const raw = await scanProjects(db, entityId);
    if (raw.length === 0) return [];

    // Les DOSSIERS masqués (0087), relus à chaque appel eux aussi — le scan est
    // mis en cache, la visibilité ne doit pas l'être.
    //
    // Le test porte sur le SOUS-ARBRE (revue Codex, 26/08) : écarter la seule
    // racine masquée laisserait un dossier PARENT visible ramasser ses
    // écritures. `/data` suivi, `/data/vault` masqué, et une note du coffre
    // ressortirait comme projet — le masquage contourné par le haut.
    const hiddenWorkspaces = (
      await db
        .select({ path: agentWorkspaces.path })
        .from(agentWorkspaces)
        .innerJoin(agents, eq(agents.id, agentWorkspaces.agentId))
        .where(and(eq(agents.entityId, entityId), eq(agentWorkspaces.hiddenFromCode, true)))
    )
      .map((r) => norm(r.path))
      .filter((p) => p !== '');
    const sousDossierMasque = (p: string): boolean => hiddenWorkspaces.some((r) => within(p, r));

    // Les deux gestes du propriétaire, relus à CHAQUE appel. Le MASQUAGE porte
    // jusqu'ici : jusqu'au 26/08 l'archivage n'était lu que par l'interface,
    // si bien qu'un projet rangé continuait d'être annoncé dans le prompt
    // système de tous les agents. Ranger quelque chose et continuer à en parler
    // à tout le monde n'avait pas de sens ; c'est la demande de Quentin, mot
    // pour mot : « que ça retire le dossier du contexte et de la mémoire des
    // agents ».
    const projectRows = await db
      .select({
        projectPath: codeProjects.projectPath,
        displayName: codeProjects.displayName,
        hidden: codeProjects.hidden,
      })
      .from(codeProjects)
      .where(eq(codeProjects.entityId, entityId));
    const hiddenPaths = new Set(
      projectRows.filter((r) => r.hidden).map((r) => projectKey(r.projectPath)),
    );
    const namesByPath = new Map(
      projectRows
        .filter((r) => r.displayName !== null && r.displayName.trim() !== '')
        .map((r) => [projectKey(r.projectPath), r.displayName!.trim()]),
    );

    return (
      raw
        // Masqué par le propriétaire : nulle part, ni dans la liste, ni dans le
        // contexte des agents. Par projet, ou par dossier entier.
        .filter((p) => !hiddenPaths.has(projectKey(p.path)) && !sousDossierMasque(p.path))
        // Le plafond s'applique APRÈS le masquage : ranger un projet doit
        // laisser la place au suivant, pas juste faire un trou dans les douze.
        .slice(0, MAX_PROJECTS)
        .map((p) => ({
          // Le nom choisi par le propriétaire l'emporte : les agents entendent
          // le projet comme lui l'appelle, sinon « modifie le portail client »
          // ne désignerait rien pour eux alors que l'onglet l'affiche ainsi.
          name:
            namesByPath.get(projectKey(p.path)) ??
            p.path.split('/').filter(Boolean).pop() ??
            p.path,
          path: p.path,
          owners: p.owners,
          lastActivityAt: p.lastActivityAt,
        }))
    );
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

/**
 * Le SCAN : la partie chère, et la seule qui soit mise en cache.
 *
 * 1500 tool_calls relus, autant de vérifications d'existence sur le disque, et
 * une remontée de projet par fichier. Rien ici ne dépend des préférences du
 * propriétaire — c'est ce qui permet de les appliquer après coup, donc à jour.
 */
async function scanProjects(db: RunnerDeps['db'], entityId: string): Promise<RawProject[]> {
  const cached = projectsCache.get(entityId);
  if (cached && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.value;

  // Les dossiers attachés aux agents de l'espace, et qui les détient. Aucun
  // dossier attaché, aucun projet à annoncer.
  const wsRows = await db
    .select({
      agentId: agentWorkspaces.agentId,
      agentName: agents.name,
      label: agentWorkspaces.label,
      path: agentWorkspaces.path,
      hiddenFromCode: agentWorkspaces.hiddenFromCode,
    })
    .from(agentWorkspaces)
    .innerJoin(agents, eq(agents.id, agentWorkspaces.agentId))
    .where(eq(agents.entityId, entityId));
  if (wsRows.length === 0) return [];

  {
    // Le masquage des dossiers (0087) N'EST PAS appliqué ici, et c'est
    // délibéré : ce scan est mis en cache 60 s. Y cuire la visibilité ferait
    // qu'un dossier masqué resterait annoncé aux agents pendant une minute, et
    // qu'un dossier réaffiché resterait absent d'autant — exactement le défaut
    // que la revue avait déjà trouvé sur les préférences de projet.
    //
    // Les racines masquées restent donc dans la liste, ce qui a un second
    // mérite : le tri par longueur leur fait gagner le match sur un dossier
    // PARENT visible. `listCodeProjectsForContext` écarte ensuite tout projet
    // qui tombe sous une racine masquée — sous-arbre compris.
    //
    const { roots, ownersByRoot } = canonicalRoots(wsRows);
    if (roots.length === 0) return [];

    /** Les dossiers de CHAQUE agent — la clé de lecture de ses chemins relatifs. */
    const wsByAgent = new Map<string, Array<{ label: string; path: string }>>();
    for (const r of wsRows) {
      const own = wsByAgent.get(r.agentId) ?? [];
      own.push({ label: r.label, path: norm(r.path) });
      wsByAgent.set(r.agentId, own);
    }

    // L'AUTEUR de chaque écriture, via son job.
    //
    // Il ne sert PAS à filtrer — c'est le dossier qui décide, pas qui a écrit.
    // Il sert à LIRE le chemin : quand un agent a plusieurs dossiers, les outils
    // Nodal enregistrent la forme `label/fichier.md`, et ce label n'est unique
    // que par agent. Sans lui, le scan essayait `<racine>/vault/note.md` sous
    // chaque racine — un chemin qui n'existe nulle part —, et ces écritures
    // n'entraient jamais dans le contexte alors que l'onglet Code, lui, les
    // résolvait (revue Codex, 26/08). Deux vues, deux vérités : exactement ce
    // que ce module existe pour éviter.
    const rows = await db
      .select({
        toolInput: toolCalls.toolInput,
        toolOutput: toolCalls.toolOutput,
        createdAt: toolCalls.createdAt,
        agentId: agentJobs.agentId,
      })
      .from(toolCalls)
      .leftJoin(agentJobs, eq(agentJobs.id, toolCalls.jobId))
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

    const writes: ScannedWrite[] = [];
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
      const abs = resolveScannedPath(
        p,
        row.agentId ? (wsByAgent.get(row.agentId) ?? []) : [],
        roots,
        existsCached,
      );
      if (!abs) continue;

      const wsRoot = roots.find((r) => within(abs, r));
      if (!wsRoot) continue;

      const projectPath = projectRootFor(abs, wsRoot, rootMemo);
      // C'est le DOSSIER DE PROJET dont on vérifie l'existence, pas le fichier
      // (revue Codex, 26/08) : un projet supprimé disparaît, un fichier
      // supprimé au fil du travail ne fait pas disparaître son projet. Même
      // règle que l'onglet Code, au caractère près.
      if (!existsCached(projectPath)) continue;
      writes.push({
        projectPath,
        owners: Array.from(ownersByRoot.get(wsRoot) ?? []),
        at: row.createdAt ? row.createdAt.toISOString() : null,
      });
    }

    const result = groupScannedWrites(writes);
    projectsCache.set(entityId, { at: Date.now(), value: result });
    return result;
  }
}
