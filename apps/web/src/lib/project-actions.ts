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
import { mkdir, realpath } from 'node:fs/promises';
import {
  eq,
  and,
  desc,
  sql,
  isNotNull,
  agents,
  agentJobs,
  agentWorkspaces,
  codeProjects,
} from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { isUnderPath } from './code-projects.ts';

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

/**
 * Le sous-dossier accepté : des segments RELATIFS, et rien d'autre.
 *
 * `''` est autorisé — le terrain lui-même devient le projet, ce qui est le cas
 * d'un dépôt attaché tel quel. Tout le reste est refusé plutôt que nettoyé :
 * aplatir `../evil` en `evil` serait accepter une demande en en exécutant une
 * autre, et l'utilisateur n'apprendrait jamais que sa saisie n'a pas été lue
 * telle qu'il l'a écrite.
 */
function isSafeSubfolder(raw: string): boolean {
  if (raw === '') return true;
  const p = raw.replace(/\\/g, '/');
  // Un chemin ABSOLU ne se rattache à aucun terrain : `C:/…`, `/…`, `//srv/…`.
  if (/^[a-z]:/i.test(p) || p.startsWith('/')) return false;
  // Caractères de contrôle : illisibles à l'écran, ingérables sur le disque.
  if (/[\u0000-\u001f]/.test(p)) return false;
  const segments = p.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

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
