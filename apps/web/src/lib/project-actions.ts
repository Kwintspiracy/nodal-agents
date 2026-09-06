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
  agents,
  agentJobs,
  agentWorkspaces,
  codeProjects,
  conversations,
  entities,
  verificationRuns,
} from '@nodal-agents/db';
import { normalizePath, projectKey, type VerifyCommand } from '@nodal-agents/shared';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { isUnderPath } from './code-projects.ts';
import { isSafeSubfolder } from './project-path.ts';
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
  registeredFrom: 'spaces' | 'conversation';
  registeredAt: Date;
  hidden: boolean;
  /** Les travaux rattachés à ce projet (`agent_jobs.project_id`). */
  jobsCount: number;
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
  kind: 'dir' | 'file';
  /** La taille d'un fichier, relue sur le disque. `null` pour un dossier. */
  bytes: number | null;
};

export type ProjectFilesView = {
  entries: ProjectFileEntry[];
  /** Les entrées au-delà du plafond — dites, jamais tues. */
  more: number;
  /** `.git` et `node_modules` : comptés, pas escamotés. */
  ignored: number;
  /** Le dossier n'est pas lisible (absent, ou ce n'est pas un dossier). */
  missing: boolean;
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
        jobsCount: Number(r.jobsCount ?? 0),
        lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt) : null,
        lastProof: r.kind === 'documents' ? null : (lastProofByKey.get(projectKey(r.path)) ?? null),
      })),
    );
  } catch (err) {
    console.error('[projects] PROJECT_LIST_FAILED', err);
    return fail('list_failed', 'Could not list projects');
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

// La règle du sous-dossier (`isSafeSubfolder`) vit dans `project-path.ts` :
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
    const path = normalizePath(
      input.subfolder === '' ? wsPath : `${wsPath}/${input.subfolder.replace(/\\/g, '/')}`,
    );
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

    const [existing] = await db
      .select({ id: codeProjects.id, registeredAt: codeProjects.registeredAt })
      .from(codeProjects)
      .where(and(eq(codeProjects.entityId, session.entityId), eq(codeProjects.projectKey, key)))
      .limit(1);

    // Une ligne DÉJÀ enregistrée est un projet : on ne le réécrit pas en
    // silence sous un autre nom ou un autre agent.
    if (existing?.registeredAt) {
      return fail('already_registered', 'This folder is already a registered project');
    }

    const registeredAt = new Date();
    if (existing) {
      // Une ligne de COMPTABILITÉ existante DEVIENT le projet : sa
      // configuration de preuve (`verify_*`) et son epoch sont conservés —
      // c'est le même dossier, et ce qui a été approuvé dessus reste vrai.
      const [updated] = await db
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

    const [inserted] = await db
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
  } catch (err) {
    console.error('[projects] PROJECT_CREATE_FAILED', err);
    return fail('create_failed', 'Could not create the project');
  }
}

// ─── getProjectPageAction ────────────────────────────────────────────────────

/** Le plafond de l'étagère : au-delà, la page n'est plus une étagère. */
const FILES_MAX = 200;

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
async function readProjectFolder(path: string): Promise<ProjectFilesView> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch {
    // Absent, illisible, ou ce n'est pas un dossier : dans les trois cas
    // l'écran n'a rien à montrer, et il le DIT (inv. #4) au lieu de dessiner
    // un dossier vide qui ressemblerait à un projet neuf.
    return { entries: [], more: 0, ignored: 0, missing: true };
  }

  let ignored = 0;
  const kept: Array<{ name: string; kind: 'dir' | 'file' }> = [];
  for (const d of dirents) {
    if (IGNORED_ENTRIES.has(d.name)) {
      ignored += 1;
      continue;
    }
    kept.push({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' });
  }
  // Les dossiers d'abord, puis le nom : c'est l'ordre d'un explorateur de
  // fichiers, celui que l'œil attend.
  kept.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  );

  const shown = kept.slice(0, FILES_MAX);
  const entries = await Promise.all(
    shown.map(async (e): Promise<ProjectFileEntry> => {
      if (e.kind === 'dir') return { ...e, bytes: null };
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
  return { entries, more: kept.length - shown.length, ignored, missing: false };
}

/**
 * La page d'UN projet : son étagère (le dossier, ses fichiers, sa preuve), ses
 * conversations, et celle que la saisie du bas prolonge.
 *
 * Bornée à l'entité de la session ET aux lignes ENREGISTRÉES : une ligne de
 * comptabilité n'est pas un projet, et lui ouvrir une page laisserait croire
 * qu'un dossier touché une fois par un agent a été déclaré.
 */
export async function getProjectPageAction(id: string): Promise<ActionResult<ProjectPageView>> {
  try {
    const session = await getSession();
    if (!session.entityId) return fail('no_entity', 'No active entity');
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid project id');
    }
    const db = getDb();

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
          eq(codeProjects.entityId, session.entityId),
          isNotNull(codeProjects.registeredAt),
        ),
      )
      .limit(1);
    if (!row) return fail('not_found', 'Project not found');

    const path = row.path;
    const key = projectKey(path);

    // Les conversations qui portent un TRAVAIL du projet — sous-requête plutôt
    // qu'un aller-retour de plus, la liste ci-dessous en a besoin telle quelle.
    const conversationIdsOfJobs = db
      .select({ id: agentJobs.conversationId })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, session.entityId),
          eq(agentJobs.projectId, id),
          isNotNull(agentJobs.conversationId),
        ),
      );

    const [jobsRows, proofRows, conversationRows, anchoredRows] = await Promise.all([
      db
        .select({
          jobsCount: sql<number>`count(*)`,
          lastActivityAt: sql<Date | null>`max(${agentJobs.createdAt})`,
        })
        .from(agentJobs)
        .where(and(eq(agentJobs.entityId, session.entityId), eq(agentJobs.projectId, id))),
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
          ),
        ),
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
            eq(conversations.entityId, session.entityId),
            or(
              eq(conversations.currentProjectId, id),
              inArray(conversations.id, conversationIdsOfJobs),
            ),
          ),
        )
        .orderBy(sql`${conversations.updatedAt} desc nulls last`)
        .limit(50),
      // La conversation DU projet, cherchée à part : la liste est plafonnée, et
      // ce que la saisie du bas prolonge ne doit pas dépendre de ce plafond.
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.entityId, session.entityId),
            eq(conversations.currentProjectId, id),
            eq(conversations.channel, 'dashboard'),
          ),
        )
        .orderBy(sql`${conversations.updatedAt} desc nulls last`)
        .limit(1),
    ]);

    const files = await readProjectFolder(path);

    // La preuve : les 3 dernières séquences (`groupVerificationRuns` les rend
    // dans l'ordre chronologique, la plus récente en dernier).
    const sequences = groupVerificationRuns(proofRows);
    const commands = row.verifyCommands ?? null;

    return ok({
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
        sequences: sequences.slice(-3),
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
    if (!rootAgentId) return fail('no_root_agent', 'Designate a ROOT agent in Settings first.');

    const [inserted] = await db
      .insert(conversations)
      .values({
        entityId: session.entityId,
        agentId: rootAgentId,
        title: project.displayName ?? basenameOf(project.path),
        origin: 'user',
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
