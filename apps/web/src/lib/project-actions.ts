'use server';

// project-actions.ts — le REGISTRE des projets, côté écran (plan « De la
// maquette au produit », P5).
//
// Un projet, ici, n'est PAS le projet dérivé de l'onglet Code (la racine
// commune des fichiers touchés, recalculée à chaque affichage). C'est un
// projet DÉCLARÉ : un sous-dossier d'un terrain d'agent, enregistré comme tel,
// que l'on peut lister et auquel un travail se rattache. Les deux vivent dans
// la même table `code_projects`, et `registered_at` les sépare — NULL = une
// ligne de comptabilité née d'un renommage, d'un masquage ou d'une écriture ;
// NOT NULL = un projet.
//
// LE DOSSIER D'ABORD, LA LIGNE ENSUITE. Il n'y a pas de transaction commune au
// disque et à la base : l'ordre est donc choisi par ce qu'un échec laisse
// derrière. Un dossier vide en trop est bénin et se supprime ; une ligne qui
// désigne un dossier inexistant est un projet fantôme que chaque écran devra
// contourner.

import 'server-only';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import {
  eq,
  and,
  or,
  desc,
  sql,
  inArray,
  isNotNull,
  isNull,
  agents,
  agentJobs,
  agentWorkspaces,
  codeProjects,
  conversations,
  entities,
  verificationRuns,
} from '@nodal-agents/db';
import {
  normalizePath,
  projectKey,
  isSafeSubfolder,
  projectFolderNameFrom,
  type VerifyCommand,
} from '@nodal-agents/shared';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { isUnderPath } from './code-projects.ts';

import { deriveVerifyStatus, type VerifyStatus } from './verification-display.ts';
import { groupVerificationRuns, type VerificationSequenceView } from './verification-runs-view.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

export type ProjectListRow = {
  id: string;
  /** `display_name`, ou le nom du dossier — jamais un chemin vide à l'écran. */
  name: string;
  path: string;
  kind: 'code' | 'documents';
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  /** L'avatar de l'agent responsable — la ligne de Workspaces l'affiche (#143). */
  agentAvatarUrl: string | null;
  registeredFrom: 'spaces' | 'conversation';
  registeredAt: Date;
  hidden: boolean;
  /** Les travaux rattachés à ce projet (`agent_jobs.project_id`). */
  jobsCount: number;
  /**
   * Les conversations du projet : celles qui y sont ANCRÉES
   * (`conversations.current_project_id`) et celles qui portent un de ses
   * travaux. Comptées comme la page du projet les liste, pour que la liste et
   * la page ne se contredisent pas (#143).
   */
  conversationsCount: number;
  /** Le plus récent d'entre eux, ou `null` : un projet neuf n'a pas d'activité. */
  lastActivityAt: Date | null;
  /**
   * L'état de la PREUVE : le verdict de la commande de vérification la plus
   * récente sur ce dossier, ou `null` — aucune n'a jamais tourné, ou le projet
   * ne produit pas de code (rien à prouver, et le dire « échec » serait faux).
   */
  lastProof: { verdict: 'pass' | 'fail'; at: Date } | null;
};

/** Une entrée du dossier, telle que l'étagère la montre. */
export type ProjectFileEntry = {
  name: string;
  /**
   * `symlink` est une sorte À PART, jamais fondue dans `file` : un lien vers un
   * dossier affiché comme fichier, avec la taille de sa cible, fait mentir
   * l'étagère sur ce qu'il y a dans le projet — et divulgue au passage la
   * taille d'un fichier qui est peut-être ailleurs (revue passe 30, doute 4).
   */
  kind: 'dir' | 'file' | 'symlink';
  /** La taille d'un fichier, relue sur le disque. `null` pour un dossier ou un lien. */
  bytes: number | null;
};

/**
 * Pourquoi le dossier n'a pas pu être lu. `null` = il l'a été.
 *
 * Une seule valeur « missing » confondait quatre situations qui n'appellent
 * pas la même réaction : un dossier supprimé, un chemin devenu fichier, un
 * refus de permission, et tout le reste. L'écran doit pouvoir dire laquelle
 * (revue passe 30, constat 3).
 */
export type ProjectFilesUnreadable = 'absent' | 'not_a_directory' | 'permission' | 'error';

export type ProjectFilesView = {
  entries: ProjectFileEntry[];
  /** Les entrées au-delà du plafond — dites, jamais tues. */
  more: number;
  /** `.git` et `node_modules` : comptés, pas escamotés. */
  ignored: number;
  /** `null` quand le dossier a été lu ; la CAUSE sinon. */
  unreadable: ProjectFilesUnreadable | null;
};

export type ProjectProofView = {
  configured: boolean;
  commands: VerifyCommand[] | null;
  approval: VerifyStatus;
  /** Les dernières séquences de preuve de CE dossier (plafond 3), la plus récente en dernier. */
  sequences: VerificationSequenceView[];
};

export type ProjectConversationRow = {
  id: string;
  channel: string;
  /** Vide quand la conversation n'a pas de titre — l'écran décide quoi dire. */
  title: string;
  agentName: string | null;
  agentSlug: string | null;
  updatedAt: Date | null;
  /** `current_project_id` pointe ici : la conversation est ANCRÉE au projet. */
  anchored: boolean;
};

export type ProjectPageView = {
  project: {
    id: string;
    name: string;
    path: string;
    kind: 'code' | 'documents';
    agentId: string | null;
    agentName: string | null;
    agentSlug: string | null;
    hidden: boolean;
    registeredFrom: 'spaces' | 'conversation';
    registeredAt: Date;
    jobsCount: number;
    lastActivityAt: Date | null;
  };
  files: ProjectFilesView;
  proof: ProjectProofView;
  conversations: ProjectConversationRow[];
  /** La conversation DU projet — celle que la saisie du bas prolonge. */
  projectConversationId: string | null;
};

export type ProjectTerrain = {
  agentId: string;
  agentName: string;
  agentSlug: string;
  workspaces: Array<{ id: string; label: string; path: string }>;
};

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

/** Le nom du dossier, quand le propriétaire n'en a pas choisi un autre. */
function basenameOf(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Combien de conversations chaque projet porte — pour TOUTE la liste, en deux
 * requêtes groupées.
 *
 * Une conversation appartient au projet de deux façons, et il faut les deux :
 * elle y est ANCRÉE (`conversations.current_project_id`), ou elle porte un
 * travail rattaché au projet (`agent_jobs.project_id` + `conversation_id`).
 * C'est l'union exacte que `loadProjectCore` liste sur la page du projet ;
 * n'en compter qu'une moitié ferait dire « 2 conversations » à une liste dont
 * la page en montre cinq.
 *
 * L'union se fait en JS sur des identifiants, pas en SQL : deux `group by`
 * indexés coûtent moins qu'un `UNION` sur une jointure, et le nombre de
 * conversations d'une entité tient en mémoire.
 */
async function countProjectConversations(
  db: ReturnType<typeof getDb>,
  entityId: string,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (projectIds.length === 0) return counts;

  const [anchored, viaJobs] = await Promise.all([
    db
      .select({ projectId: conversations.currentProjectId, id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.entityId, entityId),
          inArray(conversations.currentProjectId, [...projectIds]),
        ),
      ),
    db
      .selectDistinct({ projectId: agentJobs.projectId, id: agentJobs.conversationId })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, entityId),
          inArray(agentJobs.projectId, [...projectIds]),
          isNotNull(agentJobs.conversationId),
        ),
      ),
  ]);

  const seen = new Map<string, Set<string>>();
  for (const row of [...anchored, ...viaJobs]) {
    if (!row.projectId || !row.id) continue;
    const set = seen.get(row.projectId) ?? new Set<string>();
    set.add(row.id);
    seen.set(row.projectId, set);
  }
  for (const [projectId, set] of seen) counts.set(projectId, set.size);
  return counts;
}

// ─── listProjectsAction ──────────────────────────────────────────────────────

/**
 * Les projets ENREGISTRÉS de l'entité, les plus actifs d'abord.
 *
 * Les lignes de comptabilité sont exclues par `registered_at IS NOT NULL` : ce
 * sont des dossiers qu'un agent a touchés, pas des projets qu'on a déclarés.
 * Les MASQUÉS restent dans la liste, avec leur drapeau — masquer est un choix
 * d'affichage que l'écran applique, pas une désinscription que la requête
 * devrait deviner.
 */
export async function listProjectsAction(): Promise<ActionResult<ProjectListRow[]>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    // Le compte et la dernière activité en une passe (un LEFT JOIN groupé),
    // jamais une requête par projet : la liste est le premier écran des
    // espaces, elle ne doit pas dégrader avec le nombre de projets.
    const rows = await db
      .select({
        id: codeProjects.id,
        displayName: codeProjects.displayName,
        path: codeProjects.projectPath,
        kind: codeProjects.kind,
        hidden: codeProjects.hidden,
        registeredFrom: codeProjects.registeredFrom,
        registeredAt: codeProjects.registeredAt,
        agentId: codeProjects.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        agentAvatarUrl: agents.avatarUrl,
        jobsCount: sql<number>`count(${agentJobs.id})`,
        lastActivityAt: sql<Date | null>`max(${agentJobs.createdAt})`,
      })
      .from(codeProjects)
      .leftJoin(agents, eq(agents.id, codeProjects.agentId))
      .leftJoin(agentJobs, eq(agentJobs.projectId, codeProjects.id))
      .where(and(eq(codeProjects.entityId, session.entityId), isNotNull(codeProjects.registeredAt)))
      .groupBy(
        codeProjects.id,
        agents.name,
        agents.slug,
        agents.avatarUrl,
        // `max()` et `count()` imposent de grouper sur tout le reste : Postgres
        // ne déduit pas que la clé primaire suffit dès qu'une table jointe
        // apporte ses colonnes.
      )
      .orderBy(sql`max(${agentJobs.createdAt}) desc nulls last`, desc(codeProjects.registeredAt));

    // L'état de la preuve, en UNE requête groupée (`DISTINCT ON` sur la clé,
    // la plus récente d'abord) — pas une par projet : la liste ne doit pas
    // dégrader avec le nombre de projets, et une preuve se lit par CLÉ
    // d'identité, jamais par égalité de texte sur le chemin.
    const proofKeys = [
      ...new Set(rows.filter((r) => r.kind !== 'documents').map((r) => projectKey(r.path))),
    ];
    // Les conversations de CHAQUE projet, en DEUX requêtes groupées pour toute
    // la liste — jamais une par ligne. Deux, parce qu'une conversation
    // appartient au projet de deux façons : elle y est ANCRÉE, ou elle porte
    // un de ses travaux. C'est l'union exacte que la page du projet liste, et
    // un compte qui ne dirait que la première contredirait sa propre page.
    const conversationsCountByProject = await countProjectConversations(
      db,
      session.entityId,
      rows.map((r) => r.id),
    );
    const lastProofByKey = new Map<string, { verdict: 'pass' | 'fail'; at: Date }>();
    if (proofKeys.length > 0) {
      const proofRows = await db
        .selectDistinctOn([verificationRuns.canonicalKey], {
          canonicalKey: verificationRuns.canonicalKey,
          verdict: verificationRuns.verdict,
          createdAt: verificationRuns.createdAt,
        })
        .from(verificationRuns)
        .where(
          and(
            eq(verificationRuns.entityId, session.entityId),
            inArray(verificationRuns.canonicalKey, proofKeys),
          ),
        )
        .orderBy(verificationRuns.canonicalKey, desc(verificationRuns.createdAt));
      for (const p of proofRows) {
        // `green` est le SEUL verdict qui prouve quelque chose : un rouge et une
        // erreur d'infrastructure disent tous deux « ce n'est pas prouvé ».
        lastProofByKey.set(p.canonicalKey, {
          verdict: p.verdict === 'green' ? 'pass' : 'fail',
          at: p.createdAt,
        });
      }
    }

    return ok(
      rows.map((r) => ({
        id: r.id,
        name: r.displayName ?? basenameOf(r.path),
        path: r.path,
        kind: (r.kind === 'documents' ? 'documents' : 'code') as 'code' | 'documents',
        agentId: r.agentId,
        agentName: r.agentName ?? null,
        agentSlug: r.agentSlug ?? null,
        registeredFrom: (r.registeredFrom ?? 'spaces') as 'spaces' | 'conversation',
        registeredAt: r.registeredAt as Date,
        hidden: r.hidden,
        agentAvatarUrl: r.agentAvatarUrl ?? null,
        jobsCount: Number(r.jobsCount ?? 0),
        conversationsCount: conversationsCountByProject.get(r.id) ?? 0,
        lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null,
        lastProof: r.kind === 'documents' ? null : (lastProofByKey.get(projectKey(r.path)) ?? null),
      })),
    );
  } catch (err) {
    console.error('[projects] PROJECT_LIST_FAILED', err);
    return fail('list_failed', 'Could not list projects');
  }
}

// ─── listProofsForPathsAction ────────────────────────────────────────────────

/**
 * Le dernier verdict de preuve de chemins DONNÉS, en UNE requête.
 *
 * `listProjectsAction` fait déjà cette lecture pour les projets du registre.
 * Les dossiers DÉTECTÉS n'y sont pas, et ils peuvent avoir une preuve : une
 * séquence se configure par CLÉ de dossier (`verification_runs.canonical_key`),
 * pas par appartenance au registre. Les laisser tous en « Unverified » ferait
 * dire à la pastille le contraire de ce que le dossier porte.
 *
 * Bornée par liste : un `inArray` sur les clés, jamais un appel par ligne.
 */
export async function listProofsForPathsAction(
  paths: readonly string[],
): Promise<ActionResult<Array<{ key: string; verdict: 'pass' | 'fail'; at: Date }>>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const keys = [...new Set(paths.filter((p) => p !== '').map((p) => projectKey(p)))];
    if (keys.length === 0) return ok([]);
    // Plafond : la liste en montre au plus quelques dizaines, et une requête
    // dont la taille suit une entrée non bornée n'a pas sa place ici.
    if (keys.length > 200) return fail('validation_failed', 'Too many paths');

    const rows = await getDb()
      .selectDistinctOn([verificationRuns.canonicalKey], {
        canonicalKey: verificationRuns.canonicalKey,
        verdict: verificationRuns.verdict,
        createdAt: verificationRuns.createdAt,
      })
      .from(verificationRuns)
      .where(
        and(
          eq(verificationRuns.entityId, session.entityId),
          inArray(verificationRuns.canonicalKey, keys),
        ),
      )
      .orderBy(verificationRuns.canonicalKey, desc(verificationRuns.createdAt));

    return ok(
      rows.map((r) => ({
        key: r.canonicalKey,
        // `green` est le SEUL verdict qui prouve quelque chose — un rouge et
        // une erreur d'infrastructure disent tous deux « ce n'est pas prouvé ».
        verdict: (r.verdict === 'green' ? 'pass' : 'fail') as 'pass' | 'fail',
        at: r.createdAt,
      })),
    );
  } catch (err) {
    console.error('[projects] PROOF_LOOKUP_FAILED', err);
    return fail('proofs_failed', 'Could not read the proof state');
  }
}

// ─── registerDetectedProjectAction ───────────────────────────────────────────

const registerDetectedSchema = z.object({
  projectPath: z.string().min(1).max(4096),
  /** L'agent qui a écrit là, tel que la ligne le nomme. Vérifié au serveur. */
  agentId: z.string().uuid().nullable(),
});

/**
 * INSCRIT au registre un dossier que la détection a trouvé (#143).
 *
 * Le geste que l'onglet Code n'avait pas : un dossier où un agent a écrit
 * devient un projet, avec son responsable, sans passer par le formulaire de
 * création — le dossier existe déjà, il n'y a rien à créer sur le disque.
 *
 * LA GARDE : le chemin doit être DANS un dossier attaché à un agent de
 * l'entité. Sans elle, l'action inscrirait n'importe quel chemin de la machine
 * au registre, donc dans le contexte injecté aux agents comme endroit où ils
 * peuvent écrire. La contenance est LEXICALE ici, et c'est suffisant : le
 * chemin ne vient pas d'une saisie libre mais de la dérivation des écritures
 * déjà enregistrées, et aucun dossier n'est créé — il n'y a pas de `mkdir` à
 * détourner par un lien, ce qui est la raison d'être du contrôle physique de
 * `createProjectAction`.
 *
 * L'agent responsable est celui que la ligne nomme, à condition qu'il détienne
 * un dossier contenant le chemin. À défaut, le détenteur UNIQUE du dossier ;
 * s'ils sont plusieurs, `null` — l'ordre des lignes `agent_workspaces` n'en
 * désigne aucun, et en choisir un au hasard serait un repli malin.
 *
 * Pas de garde d'imbrication (celle de `createProjectAction`) : c'est le
 * contrat du registre lui-même, dont les autres écrivains — le backfill au
 * démarrage et l'outil `register_project` — n'en ont pas non plus. Un dossier
 * dérivé est par construction un enfant direct d'un terrain.
 */
export async function registerDetectedProjectAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; path: string }>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const parsed = registerDetectedSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid project input');
    const demande = normalizePath(parsed.data.projectPath);
    if (demande === '') return fail('validation_failed', 'Invalid project path');

    const db = getDb();
    const wsRows = await db
      .select({ agentId: agentWorkspaces.agentId, path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.entityId, session.entityId));

    // TROIS gardes, dans CET ordre, et l'ordre fait partie de la garde.
    //
    // 1. LEXICALE, sur le chemin demandé. Elle passe avant toute lecture du
    //    disque : un chemin qui ne ressemble à aucun terrain est refusé sans
    //    qu'on soit allé voir s'il existe. Sinon la réponse dirait, de
    //    n'importe quel chemin de la machine, s'il est là ou non.
    //    C'est aussi la seule qui tienne quand un terrain n'est pas encore sur
    //    le disque : la garde physique remonterait alors le terrain jusqu'à un
    //    ancêtre existant — parfois la racine du disque — et laisserait tout
    //    passer.
    const candidats = wsRows.filter((w) => {
      const root = normalizePath(w.path);
      return isUnderPath(demande, root) || projectKey(demande) === projectKey(root);
    });
    if (candidats.length === 0) {
      return fail('not_in_workspace', 'This folder is not inside a workspace of this space.');
    }

    // 2. LE CHEMIN RÉSOLU, jamais celui qu'on a reçu (revue Reviewer C, passe 1).
    //
    //    `normalizePath` uniformise les slashes et retire le slash final :
    //    elle n'aplatit NI `..` NI `.`. Et `isUnderPath` compare du texte. Les
    //    deux ensemble laissaient passer `<terrain>/../ailleurs`, qui commence
    //    bien par `<terrain>/` — le dossier entrait au registre, donc dans la
    //    liste des endroits où les agents peuvent écrire, HORS de tout terrain.
    //
    //    La même forme brute produisait un second défaut, silencieux :
    //    `<terrain>/./app` a une CLÉ différente de `<terrain>/app`, donc une
    //    seconde ligne de registre pour le même dossier, que rien n'aurait
    //    rapprochée. Résoudre règle les deux, et c'est la RÉSOLUTION — pas un
    //    motif à interdire — parce qu'un lien ment aussi bien qu'un `..`.
    //
    //    Le dossier doit donc EXISTER. Une ligne qui désigne un dossier absent
    //    est un projet fantôme que chaque écran devra contourner (en-tête de
    //    ce module), et la détection ne remonte que des dossiers écrits.
    const path = await realPathIfExists(demande);
    if (path === null) return fail('folder_missing', 'This folder is not there any more.');

    // 3. PHYSIQUE, sur le chemin résolu : elle seule attrape `..` et les liens.
    const holders: string[] = [];
    for (const w of candidats) {
      if (!(await physicallyInside(path, normalizePath(w.path)))) continue;
      if (!holders.includes(w.agentId)) holders.push(w.agentId);
    }
    if (holders.length === 0) {
      return fail('not_in_workspace', 'This folder is not inside a workspace of this space.');
    }

    const asked = parsed.data.agentId;
    // Le responsable : celui que la ligne nomme s'il détient bien le dossier,
    // sinon le détenteur UNIQUE. À plusieurs et sans nom, personne.
    const responsable =
      asked !== null && holders.includes(asked)
        ? asked
        : holders.length === 1
          ? (holders[0] ?? null)
          : null;

    const key = projectKey(path);
    // UPSERT sur la clé d'identité, `setWhere registered_at IS NULL` — la même
    // règle que `registerCodeProjects` (packages/tools) : un projet DÉJÀ au
    // registre ne se réinscrit pas, et son nom, son agent et sa date d'ajout
    // restent ceux qu'il a. L'écriture est ici et non dans ce module partagé
    // parce que `apps/web` ne dépend pas de `@nodal-agents/tools` ; les deux
    // écrivent la MÊME forme de ligne, et c'est cette forme que le test fige.
    const inserted = await db
      .insert(codeProjects)
      .values({
        entityId: session.entityId,
        projectPath: path,
        projectKey: key,
        // Un dossier trouvé par la détection des écritures de CODE : c'est ce
        // que le scan observe, et rien d'autre.
        kind: 'code',
        agentId: responsable,
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .onConflictDoUpdate({
        target: [codeProjects.entityId, codeProjects.projectKey],
        set: {
          kind: 'code',
          ...(responsable ? { agentId: responsable } : {}),
          registeredAt: new Date(),
          registeredFrom: 'spaces',
          updatedAt: new Date(),
        },
        setWhere: isNull(codeProjects.registeredAt),
      })
      .returning({ id: codeProjects.id });

    let id = inserted[0]?.id ?? null;
    if (id === null) {
      // Rien n'a été écrit : la ligne existe et porte DÉJÀ une inscription. On
      // rend son id plutôt qu'une erreur — deux onglets ouverts sur la même
      // liste, et le second clic doit mener au projet, pas à un échec.
      const [existing] = await db
        .select({ id: codeProjects.id })
        .from(codeProjects)
        .where(and(eq(codeProjects.entityId, session.entityId), eq(codeProjects.projectKey, key)))
        .limit(1);
      id = existing?.id ?? null;
    }
    if (id === null) return fail('register_failed', 'Could not register this folder');

    console.warn(`[projects] PROJECT_REGISTERED_FROM_SPACES id=${id} key=${key}`);
    revalidatePath('/spaces');
    revalidatePath('/code');
    return ok({ id, path });
  } catch (err) {
    console.error('[projects] PROJECT_REGISTER_DETECTED_FAILED', err);
    return fail('register_failed', 'Could not register this folder');
  }
}

// ─── listProjectTerrainsAction ───────────────────────────────────────────────

/**
 * Les terrains disponibles : chaque agent de l'entité, avec ses dossiers.
 *
 * C'est la matière du formulaire « Nouveau projet » (P8) : on n'y choisit pas
 * un chemin libre, on choisit un TERRAIN existant puis un sous-dossier. Un
 * agent sans dossier attaché n'a pas de terrain à offrir et ne figure pas dans
 * la liste — proposer un agent qu'on ne peut pas choisir serait une impasse.
 */
export async function listProjectTerrainsAction(): Promise<ActionResult<ProjectTerrain[]>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    const db = getDb();

    const rows = await db
      .select({
        agentId: agents.id,
        agentName: agents.name,
        agentSlug: agents.slug,
        workspaceId: agentWorkspaces.id,
        label: agentWorkspaces.label,
        path: agentWorkspaces.path,
      })
      .from(agents)
      .innerJoin(agentWorkspaces, eq(agentWorkspaces.agentId, agents.id))
      .where(eq(agents.entityId, session.entityId))
      .orderBy(agents.name, agentWorkspaces.position, agentWorkspaces.label);

    const byAgent = new Map<string, ProjectTerrain>();
    for (const r of rows) {
      let terrain = byAgent.get(r.agentId);
      if (!terrain) {
        terrain = {
          agentId: r.agentId,
          agentName: r.agentName,
          agentSlug: r.agentSlug ?? '',
          workspaces: [],
        };
        byAgent.set(r.agentId, terrain);
      }
      terrain.workspaces.push({ id: r.workspaceId, label: r.label, path: r.path });
    }
    return ok([...byAgent.values()]);
  } catch (err) {
    console.error('[projects] PROJECT_TERRAINS_FAILED', err);
    return fail('terrains_failed', 'Could not list terrains');
  }
}

// ─── createProjectAction ─────────────────────────────────────────────────────

// La règle du sous-dossier (`isSafeSubfolder`) vit dans `@nodal-agents/shared` :
// la modale de création l'applique aussi, pour montrer le chemin final pendant
// la saisie, et un module 'use server' ne se charge pas dans le navigateur.

/**
 * L'ancêtre EXISTANT le plus proche de `path` (lui-même s'il existe), résolu
 * en chemin réel — c'est lui que `mkdir -p` prolongerait, liens suivis.
 */
async function realNearestAncestor(path: string): Promise<string | null> {
  let current = normalizePath(path);
  for (;;) {
    try {
      return normalizePath(await realpath(current));
    } catch {
      const parent = current.replace(/\/[^/]*$/, '');
      if (parent === '' || parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Le chemin réel de `path`, ou `null` s'il N'EXISTE PAS.
 *
 * À ne pas confondre avec `realNearestAncestor`, qui remonte jusqu'au premier
 * ancêtre existant : ce repli-là sert à savoir où `mkdir -p` atterrirait, et il
 * est FAUX pour comparer deux projets. Un projet enregistré dont le dossier a
 * été supprimé y remontait à son parent, si bien que tout voisin créé sous ce
 * parent paraissait « dans » un projet qui n'existe plus (revue Codex, PR #49,
 * passe 4).
 */
async function realPathIfExists(path: string): Promise<string | null> {
  try {
    return normalizePath(await realpath(normalizePath(path)));
  } catch {
    return null;
  }
}

/**
 * La cible, une fois les liens suivis, reste-t-elle DANS le terrain réel ?
 *
 * Les deux côtés sont ramenés à leur ancêtre EXISTANT le plus proche : un lien
 * ne peut vivre que dans un dossier qui existe, donc c'est la partie existante
 * du chemin qui peut mentir, jamais celle que `mkdir -p` va créer. Un terrain
 * pas encore créé sur le disque (attaché d'avance, ou dans un test) partage
 * son ancêtre avec la cible et reste donc dedans — la contenance lexicale,
 * vérifiée avant, fait le reste.
 */
async function physicallyInside(target: string, terrain: string): Promise<boolean> {
  const terrainReal = await realNearestAncestor(terrain);
  const targetReal = await realNearestAncestor(target);
  if (terrainReal === null || targetReal === null) return false;
  return isUnderPath(targetReal, terrainReal);
}

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subfolder: z.string().max(200),
  kind: z.enum(['code', 'documents']),
});

/**
 * Déclare un sous-dossier d'un terrain comme PROJET.
 *
 * Trois issues d'échec distinctes, jamais fondues en une seule : le terrain
 * n'est pas à cet agent (`workspace_not_found`), la saisie sort du terrain
 * (`validation_failed`), le dossier existe déjà comme projet
 * (`already_registered`). Un code par cause, parce que l'écran doit pouvoir
 * dire laquelle.
 */
export async function createProjectAction(
  raw: unknown,
): Promise<ActionResult<{ id: string; path: string }>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');

    const parsed = createProjectSchema.safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid project input');
    const input = parsed.data;
    if (!isSafeSubfolder(input.subfolder)) {
      return fail('validation_failed', 'Subfolder must be a relative path inside the workspace');
    }

    const db = getDb();

    // Le terrain doit être à CET agent ET à l'entité de la session : les deux,
    // pas l'un ou l'autre. Le dossier d'un agent d'une autre entité n'existe
    // pas ici, et le dire autrement (« interdit ») confirmerait son existence.
    const [ws] = await db
      .select({ path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(
        and(
          eq(agentWorkspaces.id, input.workspaceId),
          eq(agentWorkspaces.agentId, input.agentId),
          eq(agentWorkspaces.entityId, session.entityId),
        ),
      )
      .limit(1);
    if (!ws) return fail('workspace_not_found', 'Workspace not found for this agent');

    const wsPath = normalizePath(ws.path);
    // Un nom de dossier VIDE ne prend plus le terrain lui-même : il se dérive du
    // nom du projet. Le dossier racine d'un développeur est un dossier DE
    // projets — personne n'y crée un projet qui l'engloberait, et l'avoir permis
    // a produit un « Recipes » qui était tout le dossier `Dev` (08/09/2026).
    //
    // La dérivation vit dans `@nodal-agents/shared` : la modale s'en sert pour
    // son aperçu, et si les deux divergeaient, l'écran promettrait un dossier
    // pendant qu'on en créerait un autre.
    const nomDossier =
      input.subfolder !== ''
        ? input.subfolder.replace(/\\/g, '/')
        : projectFolderNameFrom(input.name);
    if (nomDossier === '') {
      return fail(
        'validation_failed',
        'Give the project folder a name — the project name has nothing to derive one from.',
      );
    }
    const path = normalizePath(`${wsPath}/${nomDossier}`);
    // Défense en profondeur : la validation ci-dessus a déjà refusé `..`, mais
    // c'est le chemin FINAL qui doit être dans le terrain, et c'est lui qu'on
    // vérifie — une règle de saisie ne prouve pas un résultat.
    if (!isUnderPath(path, wsPath)) {
      return fail('validation_failed', 'Resolved path escapes the workspace');
    }

    const key = projectKey(path);

    // Contenance PHYSIQUE, pas seulement lexicale (revue passe 27) : une
    // jonction ou un lien posé dans le terrain (`terrain/lien` → ailleurs)
    // passe la validation de texte, et `mkdir` le suivrait pour créer le
    // dossier HORS du terrain. On résout donc le chemin réel du terrain et
    // celui de l'ancêtre existant le plus proche de la cible, et c'est leur
    // contenance qui décide — la même précaution que `resolveAndCheckPath`
    // côté outils.
    if (!(await physicallyInside(path, wsPath))) {
      return fail('validation_failed', 'Resolved path escapes the workspace');
    }

    // Le dossier d'abord (voir l'en-tête) : une ligne sans dossier serait un
    // projet fantôme, un dossier sans ligne n'est qu'un dossier vide.
    try {
      await mkdir(path, { recursive: true });
    } catch (err) {
      console.error(`[projects] PROJECT_MKDIR_FAILED key=${key}`, err);
      return fail('mkdir_failed', 'Could not create the project folder');
    }

    // TOUT ce qui suit tient dans UNE transaction, sous un verrou consultatif
    // par entité. Sans lui, la garde de chevauchement se contourne à deux mains
    // (revue Codex, PR #49, passe 3) : deux créations simultanées de `Dev/app`
    // et `Dev/app/sub` lisent chacune les projets AVANT l'insertion de l'autre,
    // passent la garde toutes les deux, et s'enregistrent imbriquées — leurs
    // clés étant distinctes, aucune contrainte d'unicité ne les arrête.
    //
    // Le verrou porte sur l'ENTITÉ : c'est le périmètre où les chemins se
    // comparent, et créer un projet est un geste rare — sérialiser ces
    // créations-là ne coûte rien à personne. Le dossier, lui, reste créé AVANT
    // (voir l'en-tête) : une transaction ne tient pas un verrou pendant une
    // écriture disque.
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`project-create:${session.entityId}`}))`,
      );

      const [existing] = await tx
        .select({ id: codeProjects.id, registeredAt: codeProjects.registeredAt })
        .from(codeProjects)
        .where(and(eq(codeProjects.entityId, session.entityId), eq(codeProjects.projectKey, key)))
        .limit(1);

      // Une ligne DÉJÀ enregistrée est un projet : on ne le réécrit pas en
      // silence sous un autre nom ou un autre agent.
      if (existing?.registeredAt) {
        return fail('already_registered', 'This folder is already a registered project');
      }

      // Un projet ne CONTIENT pas un autre projet, et n'est pas DEDANS.
      //
      // Vécu le 08/09/2026 : « Recipes » créé en laissant « Subfolder » vide est
      // devenu le dossier `Dev` entier, qui portait déjà dix-huit projets. Le
      // travail suivant s'est rattaché à cette racine ; `Dev/recipes-app` a été
      // enregistré douze minutes plus tard, et il était trop tard — un job
      // rattaché ne se rattache pas deux fois. Résultat à l'écran : deux projets
      // pour un seul travail, dont l'un raconte ce qui s'est fait dans l'autre.
      //
      // La garde d'avant ne comparait que l'égalité EXACTE du chemin, elle ne
      // pouvait pas voir ça. Celle-ci compare la CONTENANCE, dans les deux sens,
      // sur la frontière de segment — `projet-x` n'avale pas `projet-x-bis`.
      //
      // Et elle la compare PHYSIQUEMENT, par les chemins réels : une jonction
      // `Dev/alias` → `Dev/app` n'a aucune contenance LEXICALE avec `Dev/app`,
      // si bien qu'un projet déclaré en `Dev/alias/sub` se serait enregistré à
      // l'intérieur du projet `app` (revue Codex, PR #49, passe 3). C'est la
      // même précaution que `physicallyInside` prend déjà pour la frontière du
      // terrain, et pour la même raison : sur Windows, une jonction se traverse
      // sans qu'aucune comparaison de texte ne le voie.
      const registres = await tx
        .select({ path: codeProjects.projectPath })
        .from(codeProjects)
        .where(
          and(eq(codeProjects.entityId, session.entityId), isNotNull(codeProjects.registeredAt)),
        );
      // Les chemins RÉELS, et seulement ceux qui EXISTENT : un projet dont le
      // dossier a disparu n'a plus de chemin réel, et lui en inventer un —
      // celui de son parent, ce que fait `realNearestAncestor` — le ferait
      // avaler tous ses voisins (revue Codex, PR #49, passe 4).
      const cheminReel = await realPathIfExists(path);
      for (const r of registres) {
        const autre = normalizePath(r.path);
        const autreReel = await realPathIfExists(autre);
        const dedans =
          isUnderPath(path, autre) ||
          (cheminReel !== null && autreReel !== null && isUnderPath(cheminReel, autreReel));
        if (dedans) {
          return fail(
            'overlaps_registered',
            `This folder is inside the project "${autre}". Pick a folder that does not overlap one.`,
          );
        }
        const contient =
          isUnderPath(autre, path) ||
          (cheminReel !== null && autreReel !== null && isUnderPath(autreReel, cheminReel));
        if (contient) {
          // Le refus NOMME LE GESTE, et dit combien de projets sont en cause.
          // La première version citait le premier trouvé et concluait « pick a
          // folder that does not overlap one » : sur un terrain qui en portait
          // quatre, elle donnait l'impression d'un cas isolé et ne disait pas
          // qu'un simple nom de sous-dossier suffisait (Quentin, 09/09/2026).
          const dedans = registres
            .map((r) => normalizePath(r.path))
            .filter((p) => isUnderPath(p, path) && p !== path)
            .map((p) => p.slice(p.lastIndexOf('/') + 1));
          const combien =
            dedans.length === 1
              ? `the project "${dedans[0]}"`
              : `${dedans.length} projects (${dedans.slice(0, 4).join(', ')}${dedans.length > 4 ? '…' : ''})`;
          return fail(
            'overlaps_registered',
            `This folder already holds ${combien}. Name a subfolder above to create the new ` +
              'project inside it.',
          );
        }
      }

      const registeredAt = new Date();
      if (existing) {
        // Une ligne de COMPTABILITÉ existante DEVIENT le projet : sa
        // configuration de preuve (`verify_*`) et son epoch sont conservés —
        // c'est le même dossier, et ce qui a été approuvé dessus reste vrai.
        const [updated] = await tx
          .update(codeProjects)
          .set({
            displayName: input.name,
            kind: input.kind,
            agentId: input.agentId,
            registeredAt,
            registeredFrom: 'spaces',
            projectPath: path,
            updatedAt: registeredAt,
          })
          .where(eq(codeProjects.id, existing.id))
          .returning({ id: codeProjects.id });
        if (!updated) return fail('create_failed', 'Could not register the project');
        revalidatePath('/spaces');
        return ok({ id: updated.id, path });
      }

      const [inserted] = await tx
        .insert(codeProjects)
        .values({
          entityId: session.entityId,
          projectPath: path,
          projectKey: key,
          displayName: input.name,
          kind: input.kind,
          agentId: input.agentId,
          registeredAt,
          registeredFrom: 'spaces',
        })
        .returning({ id: codeProjects.id });
      if (!inserted) return fail('create_failed', 'Could not register the project');

      revalidatePath('/spaces');
      return ok({ id: inserted.id, path });
    });
  } catch (err) {
    console.error('[projects] PROJECT_CREATE_FAILED', err);
    return fail('create_failed', 'Could not create the project');
  }
}

// ─── getProjectPageAction ────────────────────────────────────────────────────

/** Le plafond de l'étagère : au-delà, la page n'est plus une étagère. */
const FILES_MAX = 200;

/** Ce que la page montre de la preuve — et donc ce que la requête lit. */
const PROOF_SEQUENCES_MAX = 3;

/**
 * Les deux dossiers qu'on ne montre pas comme des dossiers du projet — mais
 * qu'on COMPTE. Escamoter en silence ferait mentir « voici ce qu'il y a
 * dedans » ; les lister noierait tout le reste.
 */
const IGNORED_ENTRIES = new Set(['.git', 'node_modules']);

/**
 * Le contenu du dossier, sur UN niveau. Jamais de récursion : l'étagère dit ce
 * qu'il y a dans le projet, pas ce qu'il y a dans tout l'arbre — et une
 * récursion sur un dossier de développement lit des dizaines de milliers
 * d'entrées pour un écran qui en montre deux cents.
 *
 * Le listage est réécrit ici plutôt qu'emprunté au runner : le web ne dépend
 * pas du runner (dependency-cruiser l'interdit), et ce dont l'écran a besoin —
 * un nom, une sorte, une taille — est plus court que l'inventaire du runner.
 */
/** Le code d'erreur POSIX rendu par Node, quand il y en a un. */
function errnoOf(err: unknown): string | null {
  return err !== null && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : null;
}

/** La CAUSE d'un échec de listage, telle que l'écran la dira. */
function unreadableCause(err: unknown): ProjectFilesUnreadable {
  switch (errnoOf(err)) {
    case 'ENOENT':
      return 'absent';
    case 'ENOTDIR':
      return 'not_a_directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission';
    default:
      return 'error';
  }
}

/** L'ordre d'un explorateur de fichiers : dossiers, liens, fichiers, par nom. */
const KIND_RANK: Record<ProjectFileEntry['kind'], number> = { dir: 0, symlink: 1, file: 2 };

async function readProjectFolder(path: string): Promise<ProjectFilesView> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    // L'écran n'a rien à montrer, et il DIT pourquoi (inv. #4) au lieu de
    // dessiner un dossier vide qui ressemblerait à un projet neuf — ou
    // d'annoncer une suppression là où il n'y a qu'un refus de permission.
    return { entries: [], more: 0, ignored: 0, unreadable: unreadableCause(err) };
  }

  let ignored = 0;
  const kept: Array<{ name: string; kind: ProjectFileEntry['kind'] }> = [];
  for (const d of dirents) {
    if (IGNORED_ENTRIES.has(d.name)) {
      ignored += 1;
      continue;
    }
    // Le lien AVANT le dossier : `isDirectory()` est faux sur un lien, et le
    // classer en `file` puis le mesurer suivrait le lien jusqu'à sa cible.
    const kind = d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file';
    kept.push({ name: d.name, kind });
  }
  kept.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : KIND_RANK[a.kind] - KIND_RANK[b.kind],
  );

  const shown = kept.slice(0, FILES_MAX);
  const entries = await Promise.all(
    shown.map(async (e): Promise<ProjectFileEntry> => {
      // Un lien n'est JAMAIS mesuré : `stat` le suivrait, et la taille rendue
      // serait celle d'une cible qui peut vivre hors du projet.
      if (e.kind !== 'file') return { ...e, bytes: null };
      try {
        const s = await stat(`${path}/${e.name}`);
        return { ...e, bytes: s.size };
      } catch {
        // Un fichier disparu entre le listage et la mesure : on le montre
        // quand même, sans taille, plutôt que de faire échouer la page.
        return { ...e, bytes: null };
      }
    }),
  );
  return { entries, more: kept.length - shown.length, ignored, unreadable: null };
}

/**
 * Ce que la page d'un projet lit SANS toucher au dossier ni à la preuve : le
 * projet, ses conversations, celle que la saisie prolonge, et l'agent ROOT —
 * celui à qui `createProjectConversationAction` attribue la conversation du
 * projet, donc celui que la saisie doit nommer quand elle va la créer (revue
 * Codex, passe 60 : nommer l'agent du fil lu affirmait un faux destinataire).
 */
/** Le projet sans son activité : la page du fil n'affiche ni compte de travaux ni dernière date. */
export type ProjectSummary = Omit<ProjectPageView['project'], 'jobsCount' | 'lastActivityAt'>;

export type ProjectThreadPageView = {
  project: ProjectSummary;
  conversations: ProjectConversationRow[];
  projectConversationId: string | null;
  rootAgent: { id: string; name: string } | null;
};

type ProjectCore = {
  /** Ce que la page du dossier relit de la ligne, au-delà de `project`. */
  row: {
    path: string;
    verifyCommands: VerifyCommand[] | null;
    verifyApprovedManifestHash: string | null;
  };
  project: ProjectSummary;
  conversations: ProjectConversationRow[];
  projectConversationId: string | null;
  rootAgent: { id: string; name: string } | null;
};

/**
 * Le cœur commun aux deux pages d'un projet — le fil (`/spaces/[id]`) et le
 * dossier (`/spaces/[id]/files`). Ni lecture du dossier, ni séquences de
 * preuve : la page du fil les payait à chaque ouverture et à chaque
 * rafraîchissement sans les montrer (revue Codex, passe 60).
 *
 * Borné à l'entité ET aux lignes ENREGISTRÉES : une ligne de comptabilité
 * n'est pas un projet, et lui ouvrir une page laisserait croire qu'un dossier
 * touché une fois par un agent a été déclaré.
 */
async function loadProjectCore(
  db: ReturnType<typeof getDb>,
  entityId: string,
  id: string,
): Promise<ProjectCore | null> {
  const [row] = await db
    .select({
      id: codeProjects.id,
      displayName: codeProjects.displayName,
      path: codeProjects.projectPath,
      kind: codeProjects.kind,
      hidden: codeProjects.hidden,
      registeredFrom: codeProjects.registeredFrom,
      registeredAt: codeProjects.registeredAt,
      agentId: codeProjects.agentId,
      agentName: agents.name,
      agentSlug: agents.slug,
      verifyCommands: codeProjects.verifyCommands,
      verifyApprovedManifestHash: codeProjects.verifyApprovedManifestHash,
    })
    .from(codeProjects)
    .leftJoin(agents, eq(agents.id, codeProjects.agentId))
    .where(
      and(
        eq(codeProjects.id, id),
        eq(codeProjects.entityId, entityId),
        isNotNull(codeProjects.registeredAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const path = row.path;

  // Les conversations qui portent un TRAVAIL du projet — sous-requête plutôt
  // qu'un aller-retour de plus, la liste ci-dessous en a besoin telle quelle.
  const conversationIdsOfJobs = db
    .select({ id: agentJobs.conversationId })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.entityId, entityId),
        eq(agentJobs.projectId, id),
        isNotNull(agentJobs.conversationId),
      ),
    );

  // Pas de compte de travaux ici : la page du fil ne l'affiche pas, et
  // l'agrégat sur `agent_jobs` se payait à chaque ouverture (passe 61). La
  // page du dossier le lit à part.
  const [conversationRows, anchoredRows, rootRows] = await Promise.all([
    db
      .select({
        id: conversations.id,
        channel: conversations.channel,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        currentProjectId: conversations.currentProjectId,
        agentName: agents.name,
        agentSlug: agents.slug,
      })
      .from(conversations)
      .leftJoin(agents, eq(agents.id, conversations.agentId))
      .where(
        and(
          eq(conversations.entityId, entityId),
          or(
            eq(conversations.currentProjectId, id),
            inArray(conversations.id, conversationIdsOfJobs),
          ),
        ),
      )
      .orderBy(sql`${conversations.updatedAt} desc nulls last`)
      .limit(50),
    // La conversation DU projet : celle qui a été OUVERTE depuis lui
    // (`origin = 'project'`), pas la plus récemment ancrée. Une conversation
    // ancrée par une production qui a atterri dans le dossier finissait par
    // évincer celle qu'on avait ouverte exprès, dès que son `updated_at`
    // passait devant — la saisie changeait de fil toute seule (revue passe
    // 30, doute 1). Le canal est implicite : `createProjectConversationAction`
    // est le seul écrivain de cette origine, et il écrit `dashboard`.
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.entityId, entityId),
          eq(conversations.currentProjectId, id),
          eq(conversations.origin, 'project'),
        ),
      )
      .orderBy(sql`${conversations.updatedAt} desc nulls last`)
      .limit(1),
    // L'agent ROOT de l'entité — la MÊME lecture que `createProjectConversationAction`.
    db
      .select({ id: agents.id, name: agents.name })
      .from(entities)
      .innerJoin(agents, eq(agents.id, entities.rootAgentId))
      .where(eq(entities.id, entityId))
      .limit(1),
  ]);

  return {
    row: {
      path,
      verifyCommands: row.verifyCommands ?? null,
      verifyApprovedManifestHash: row.verifyApprovedManifestHash,
    },
    project: {
      id: row.id,
      name: row.displayName ?? basenameOf(path),
      path,
      kind: (row.kind === 'documents' ? 'documents' : 'code') as 'code' | 'documents',
      agentId: row.agentId,
      agentName: row.agentName ?? null,
      agentSlug: row.agentSlug ?? null,
      hidden: row.hidden,
      registeredFrom: (row.registeredFrom ?? 'spaces') as 'spaces' | 'conversation',
      registeredAt: row.registeredAt as Date,
    },
    conversations: conversationRows.map(
      (c): ProjectConversationRow => ({
        id: c.id,
        channel: c.channel,
        title: c.title,
        agentName: c.agentName ?? null,
        agentSlug: c.agentSlug ?? null,
        updatedAt: c.updatedAt,
        anchored: c.currentProjectId === id,
      }),
    ),
    projectConversationId: anchoredRows[0]?.id ?? null,
    rootAgent: rootRows[0] ? { id: rootRows[0].id, name: rootRows[0].name } : null,
  };
}

/** La page du FIL d'un projet (`/spaces/[id]`) : le cœur, rien de plus. */
export async function getProjectThreadPageAction(
  id: string,
): Promise<ActionResult<ProjectThreadPageView>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid project id');
    }
    const core = await loadProjectCore(getDb(), session.entityId, id);
    if (core === null) return fail('not_found', 'Project not found');
    return ok({
      project: core.project,
      conversations: core.conversations,
      projectConversationId: core.projectConversationId,
      rootAgent: core.rootAgent,
    });
  } catch (err) {
    console.error('[projects] PROJECT_THREAD_PAGE_FAILED', err);
    return fail('page_failed', 'Could not load the project');
  }
}

/**
 * La page du DOSSIER d'un projet (`/spaces/[id]/files`) : le cœur, plus le
 * dossier lu et ses dernières séquences de preuve.
 */
export async function getProjectPageAction(id: string): Promise<ActionResult<ProjectPageView>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid project id');
    }
    const db = getDb();
    const core = await loadProjectCore(db, session.entityId, id);
    if (core === null) return fail('not_found', 'Project not found');
    const { row } = core;
    const path = row.path;
    const key = projectKey(path);

    // Les 3 DERNIÈRES séquences de preuve, choisies en SQL. La page n'en montre
    // que trois : charger tout l'historique de la clé pour en jeter presque
    // tout faisait grandir le coût de la page avec l'âge du projet (revue
    // passe 30, constat 2). Une sous-requête, pas un aller-retour de plus.
    const lastSequenceIds = db
      .select({ id: verificationRuns.sequenceId })
      .from(verificationRuns)
      .where(
        and(
          eq(verificationRuns.entityId, session.entityId),
          eq(verificationRuns.canonicalKey, key),
        ),
      )
      .groupBy(verificationRuns.sequenceId)
      .orderBy(sql`max(${verificationRuns.createdAt}) desc`)
      .limit(PROOF_SEQUENCES_MAX);

    const [proofRows, files, jobsRows] = await Promise.all([
      db
        .select({
          jobId: verificationRuns.jobId,
          deliverableType: verificationRuns.deliverableType,
          canonicalKey: verificationRuns.canonicalKey,
          sequenceId: verificationRuns.sequenceId,
          commandRank: verificationRuns.commandRank,
          command: verificationRuns.command,
          exitCode: verificationRuns.exitCode,
          outcomeKind: verificationRuns.outcomeKind,
          durationMs: verificationRuns.durationMs,
          verdict: verificationRuns.verdict,
          testedGeneration: verificationRuns.testedGeneration,
          testedEpoch: verificationRuns.testedEpoch,
          createdAt: verificationRuns.createdAt,
        })
        .from(verificationRuns)
        .where(
          and(
            eq(verificationRuns.entityId, session.entityId),
            eq(verificationRuns.canonicalKey, key),
            inArray(verificationRuns.sequenceId, lastSequenceIds),
          ),
        ),
      readProjectFolder(path),
      // L'activité du projet (compte de travaux, dernière date) : l'étagère
      // l'affiche, la page du fil non — elle ne la lit donc pas.
      db
        .select({
          jobsCount: sql<number>`count(*)`,
          lastActivityAt: sql<Date | null>`max(${agentJobs.createdAt})`,
        })
        .from(agentJobs)
        .where(and(eq(agentJobs.entityId, session.entityId), eq(agentJobs.projectId, id))),
    ]);

    // La preuve : au plus 3 séquences, la requête s'en est chargée
    // (`groupVerificationRuns` les rend dans l'ordre chronologique, la plus
    // récente en dernier).
    const sequences = groupVerificationRuns(proofRows);
    const commands = row.verifyCommands ?? null;

    return ok({
      project: {
        ...core.project,
        jobsCount: Number(jobsRows[0]?.jobsCount ?? 0),
        lastActivityAt: jobsRows[0]?.lastActivityAt ? new Date(jobsRows[0].lastActivityAt) : null,
      },
      files,
      proof: {
        configured: commands !== null && commands.length > 0,
        commands,
        approval: deriveVerifyStatus({
          projectPath: path,
          verifyCommands: commands,
          verifyApprovedManifestHash: row.verifyApprovedManifestHash,
        }),
        sequences,
      },
      conversations: core.conversations,
      projectConversationId: core.projectConversationId,
    });
  } catch (err) {
    console.error('[projects] PROJECT_PAGE_FAILED', err);
    return fail('page_failed', 'Could not load the project');
  }
}

// ─── createProjectConversationAction ─────────────────────────────────────────

/**
 * Ouvre une conversation ANCRÉE à un projet.
 *
 * `current_project_id` est posé DÈS la création, avant le moindre tour : c'est
 * ce qui fait que le prompt (P6) nomme le bon dossier au premier message, et
 * que le travail escaladé porte `project_id`. L'attendre d'une première
 * production ferait commencer la conversation sans son projet.
 *
 * L'agent est le ROOT, la même règle que `createConversationAction` : c'est lui
 * qui répond dans le dashboard, et un projet ne change pas d'interlocuteur.
 */
export async function createProjectConversationAction(
  projectId: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    if (!z.string().guid().safeParse(projectId).success) {
      return fail('validation_failed', 'Invalid project id');
    }
    const db = getDb();

    const [project] = await db
      .select({
        id: codeProjects.id,
        displayName: codeProjects.displayName,
        path: codeProjects.projectPath,
      })
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.id, projectId),
          eq(codeProjects.entityId, session.entityId),
          isNotNull(codeProjects.registeredAt),
        ),
      )
      .limit(1);
    if (!project) return fail('not_found', 'Project not found');

    const [entity] = await db
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, session.entityId))
      .limit(1);
    const rootAgentId = entity?.rootAgentId ?? null;
    // Le ROOT n'est pas désigné à la main : il naît avec le premier
    // orchestrateur créé (revue Codex, passe 62).
    if (!rootAgentId) {
      return fail(
        'no_root_agent',
        'No ROOT agent yet. Create an orchestrator agent first: the first one you create becomes this workspace’s ROOT.',
      );
    }

    const [inserted] = await db
      .insert(conversations)
      .values({
        entityId: session.entityId,
        agentId: rootAgentId,
        title: project.displayName ?? basenameOf(project.path),
        // `project`, pas `user` (0097) : c'est cette ORIGINE qui désigne « la
        // conversation du projet », celle que la saisie du bas prolonge.
        origin: 'project',
        channel: 'dashboard',
        currentProjectId: project.id,
      })
      .returning({ id: conversations.id });
    if (!inserted) return fail('create_failed', 'Could not open the conversation');

    revalidatePath('/chat');
    revalidatePath(`/spaces/${projectId}`);
    return ok({ id: inserted.id });
  } catch (err) {
    console.error('[projects] PROJECT_CONVERSATION_FAILED', err);
    return fail('create_failed', 'Could not open the conversation');
  }
}
