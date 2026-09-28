// repos/conversation-runs.ts — ce qui tourne dans une conversation, et
// l'arrêter (#567).
//
// UN seul chemin d'annulation. Le bouton Stop du web (`cancelJobAction`,
// apps/web/src/lib/actions.ts) portait la cascade en SQL inline ; un agent à qui
// l'on dit « arrête » sur un canal n'avait, lui, aucun moyen d'arrêter quoi que
// ce soit. La cascade vit désormais ici et les deux gestes l'appellent : un
// second chemin aurait fini par arrêter autre chose que le premier.
//
// Ce qu'un « run » est ici : un job de TÊTE de la conversation (celui qu'un
// message a lancé), tout ce qu'il a délégué (`parent_job_id`), les tâches du
// tableau qu'il a créées (`agent_tasks.root_job_id`, détachées du graphe des
// jobs) et les approbations ou questions en attente sur l'un de ces jobs. C'est
// l'unité que le web arrête déjà (« de TÊTE seulement », conversation-actions.ts).
//
// Un run est VIVANT tant qu'un seul de ses morceaux l'est — pas seulement sa
// tête. Le 28/09, la tête avait été déclarée morte par le faucheur pendant que
// son délégué ComfyArtist tournait encore deux heures : lire le statut de la
// tête seule aurait répondu « rien ne tourne », exactement le faux de l'incident.

import { and, asc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { TERMINAL_STATUSES } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { agentTasks } from '../schema/tasks.ts';
import { approvalRequests } from '../schema/approvals.ts';
import { agents } from '../schema/agents.ts';

/** Statuts d'une tâche du tableau qui n'a pas fini — ceux que l'arrêt coupe. */
const OPEN_TASK_STATUSES = ['todo', 'in_progress'];

/** Ce que l'annulation a réellement changé, ligne par ligne. */
export interface CancelledTree {
  /** Les jobs passés à `cancelled` (la cible comprise, si elle vivait encore). */
  readonly jobIds: string[];
  /** Les tâches du tableau passées à `cancelled`. */
  readonly taskIds: string[];
  /** Les approbations et questions en attente passées à `expired`. */
  readonly requestIds: string[];
}

function notTerminal() {
  // `NULL NOT IN (…)` vaut « inconnu » et exclurait la ligne : un job sans
  // statut n'a pas fini (même lecture que run-chat-turn.ts).
  return or(isNull(agentJobs.status), notInArray(agentJobs.status, [...TERMINAL_STATUSES]));
}

/** `rootIds` et tous leurs descendants par `parent_job_id`, dans cet espace. */
async function withDescendants(
  db: AnyDrizzleDb,
  entityId: string,
  rootIds: readonly string[],
): Promise<string[]> {
  const seen = new Set(rootIds);
  let frontier = [...rootIds];
  // Borné par la profondeur de délégation (invariant #8) ; `seen` garde la
  // boucle finie même sur un graphe corrompu.
  while (frontier.length > 0) {
    const rows = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.parentJobId, frontier)));
    frontier = rows.map((r) => r.id).filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }
  return [...seen];
}

/**
 * Annule un job et tout ce qui en descend : les jobs non terminés passent à
 * `cancelled`, les tâches ouvertes du tableau à `cancelled`, les approbations
 * et questions en attente à `expired` (une réponse tardive ne peut plus
 * ressusciter le job ni lancer son outil).
 *
 * Coopératif, pas un `kill` : un job `processing` relit son statut au début de
 * chaque tour (apps/runner/src/job/execute.ts) et s'arrête au contrôle suivant.
 *
 * Ne touche rien de terminé, et ne refuse rien : c'est à l'appelant de dire ce
 * qu'un résultat vide veut dire. Tout est écrit dans UNE transaction, borné à
 * `entityId` à chaque écriture.
 */
export async function cancelJobTree(
  db: AnyDrizzleDb,
  input: { entityId: string; jobId: string },
): Promise<CancelledTree> {
  const { entityId, jobId } = input;
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [target] = await t
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.entityId, entityId)))
      .limit(1);
    if (!target) return { jobIds: [], taskIds: [], requestIds: [] };

    const ids = await withDescendants(t, entityId, [jobId]);
    const now = new Date();
    const jobs = await t
      .update(agentJobs)
      .set({ status: 'cancelled', updatedAt: now })
      .where(and(inArray(agentJobs.id, ids), eq(agentJobs.entityId, entityId), notTerminal()))
      .returning({ id: agentJobs.id });
    const tasks = await t
      .update(agentTasks)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          inArray(agentTasks.rootJobId, ids),
          eq(agentTasks.entityId, entityId),
          inArray(agentTasks.status, OPEN_TASK_STATUSES),
        ),
      )
      .returning({ id: agentTasks.id });
    const requests = await t
      .update(approvalRequests)
      .set({ status: 'expired', resolvedAt: now, resolvedBy: 'system:job_cancelled' })
      .where(
        and(
          inArray(approvalRequests.jobId, ids),
          eq(approvalRequests.entityId, entityId),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .returning({ id: approvalRequests.id });
    return {
      jobIds: jobs.map((r) => r.id),
      taskIds: tasks.map((r) => r.id),
      requestIds: requests.map((r) => r.id),
    };
  });
}

/** Un job vivant d'un run, tel que l'agent le lit. */
export interface ConversationRunJob {
  readonly id: string;
  readonly parentJobId: string | null;
  readonly agentSlug: string | null;
  readonly status: string | null;
  readonly task: string;
  readonly createdAt: Date | null;
}

/** Un run vivant d'une conversation : sa tête et tout ce qui y court encore. */
export interface ConversationRun {
  /** Le job de tête : l'identifiant par lequel on arrête ce run. */
  readonly headJobId: string;
  /** Le statut de la tête — terminal possible alors qu'un délégué court encore. */
  readonly headStatus: string | null;
  readonly headTask: string;
  readonly startedAt: Date | null;
  /** Les jobs non terminés du run, la tête comprise quand elle vit. */
  readonly liveJobs: ConversationRunJob[];
  /** Les tâches du tableau pas encore finies. */
  readonly openTasks: Array<{
    id: string;
    title: string;
    status: string;
    assignedTo: string | null;
  }>;
  /** Les approbations et questions qui attendent une réponse. */
  readonly pendingRequests: Array<{
    id: string;
    jobId: string;
    kind: string;
    toolName: string;
    requestedAt: Date | null;
  }>;
}

/**
 * Les runs VIVANTS d'une conversation, toute l'arborescence lue : têtes,
 * délégations, tâches du tableau, approbations et questions en attente.
 *
 * Lu depuis ce qui VIT (`conversation_id` est posé sur chaque job de la
 * conversation, têtes comme enfants : router/delegate.ts, cron/execute-ready.ts),
 * puis remonté jusqu'à la tête par `parent_job_id`. Un fil Telegram de mille
 * messages a mille têtes terminées : les parcourir toutes pour en trouver une
 * vivante coûterait mille lectures à chaque « qu'est-ce qui tourne ? ».
 *
 * `excludeHeadJobId` retire le run de l'appelant lui-même : le tour qui demande
 * ce qui tourne n'est pas un run à arrêter.
 */
export async function listConversationRuns(
  db: AnyDrizzleDb,
  input: { entityId: string; conversationId: string; excludeHeadJobId?: string },
): Promise<ConversationRun[]> {
  const { entityId, conversationId, excludeHeadJobId } = input;
  const inConversation = and(
    eq(agentJobs.entityId, entityId),
    eq(agentJobs.conversationId, conversationId),
  );

  const liveJobs = await db
    .select({
      id: agentJobs.id,
      parentJobId: agentJobs.parentJobId,
      agentSlug: agents.slug,
      status: agentJobs.status,
      task: agentJobs.task,
      createdAt: agentJobs.createdAt,
    })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(and(inConversation, notTerminal()))
    .orderBy(asc(agentJobs.createdAt), asc(agentJobs.id));
  const openTasks = await db
    .select({
      id: agentTasks.id,
      rootJobId: agentJobs.id,
      title: agentTasks.title,
      status: agentTasks.status,
      assignedTo: agents.slug,
    })
    .from(agentTasks)
    .innerJoin(agentJobs, eq(agentJobs.id, agentTasks.rootJobId))
    .leftJoin(agents, eq(agents.id, agentTasks.assignedAgentId))
    .where(
      and(
        inConversation,
        eq(agentTasks.entityId, entityId),
        inArray(agentTasks.status, OPEN_TASK_STATUSES),
      ),
    )
    .orderBy(asc(agentTasks.createdAt), asc(agentTasks.id));
  const pendingRequests = await db
    .select({
      id: approvalRequests.id,
      jobId: approvalRequests.jobId,
      kind: approvalRequests.kind,
      toolName: approvalRequests.toolName,
      requestedAt: approvalRequests.requestedAt,
    })
    .from(approvalRequests)
    .innerJoin(agentJobs, eq(agentJobs.id, approvalRequests.jobId))
    .where(
      and(
        inConversation,
        eq(approvalRequests.entityId, entityId),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(asc(approvalRequests.requestedAt), asc(approvalRequests.id));

  // Chaque job concerné → sa tête, en remontant `parent_job_id` (borné par la
  // profondeur de délégation ; `parentOf` garde la boucle finie).
  const parentOf = new Map<string, string | null>();
  for (const j of liveJobs) parentOf.set(j.id, j.parentJobId);
  let unknown = [
    ...new Set([
      ...liveJobs.map((j) => j.parentJobId),
      ...openTasks.map((t) => t.rootJobId),
      ...pendingRequests.map((r) => r.jobId),
    ]),
  ].filter((id): id is string => id !== null && !parentOf.has(id));
  while (unknown.length > 0) {
    const rows = await db
      .select({ id: agentJobs.id, parentJobId: agentJobs.parentJobId })
      .from(agentJobs)
      .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, unknown)));
    for (const id of unknown) parentOf.set(id, null);
    for (const r of rows) parentOf.set(r.id, r.parentJobId);
    unknown = rows
      .map((r) => r.parentJobId)
      .filter((id): id is string => id !== null && !parentOf.has(id));
  }
  const headOf = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    for (;;) {
      const parent = parentOf.get(cur) ?? null;
      if (parent === null || seen.has(parent)) return cur;
      seen.add(cur);
      cur = parent;
    }
  };

  const byHead = new Map<string, Omit<ConversationRun, 'headStatus' | 'headTask' | 'startedAt'>>();
  const runOf = (jobId: string) => {
    const headJobId = headOf(jobId);
    let run = byHead.get(headJobId);
    if (!run) {
      run = { headJobId, liveJobs: [], openTasks: [], pendingRequests: [] };
      byHead.set(headJobId, run);
    }
    return run;
  };
  for (const j of liveJobs) runOf(j.id).liveJobs.push(j);
  for (const { rootJobId, ...t } of openTasks) runOf(rootJobId).openTasks.push(t);
  for (const r of pendingRequests) runOf(r.jobId).pendingRequests.push(r);
  if (excludeHeadJobId !== undefined) byHead.delete(excludeHeadJobId);
  if (byHead.size === 0) return [];

  const heads = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      task: agentJobs.task,
      createdAt: agentJobs.createdAt,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, [...byHead.keys()])))
    .orderBy(asc(agentJobs.createdAt), asc(agentJobs.id));
  return heads.map((h) => ({
    ...byHead.get(h.id)!,
    headStatus: h.status,
    headTask: h.task,
    startedAt: h.createdAt,
  }));
}
