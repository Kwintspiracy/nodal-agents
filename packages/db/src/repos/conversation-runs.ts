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

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
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
  /**
   * Les messages qui attendaient dans la file d'un job arrêté (#531), retirés
   * sans être relancés : l'arrêt vaut pour ce que la personne avait ajouté au
   * travail qu'elle arrête. Rendus ici, jamais jetés en silence.
   */
  readonly discardedMessages: Array<{ jobId: string; task: string }>;
}

function notTerminal() {
  // `NULL NOT IN (…)` vaut « inconnu » et exclurait la ligne : un job sans
  // statut n'a pas fini (même lecture que run-chat-turn.ts).
  return or(isNull(agentJobs.status), notInArray(agentJobs.status, [...TERMINAL_STATUSES]));
}

/**
 * Annule un job et tout ce qui en descend : les jobs non terminés passent à
 * `cancelled`, les tâches ouvertes du tableau à `cancelled`, les approbations
 * et questions en attente à `expired` (une réponse tardive ne peut plus
 * ressusciter le job ni lancer son outil).
 *
 * Coopératif, pas un `kill` : chaque runtime relit la ligne de son job et
 * s'arrête dessus (la boucle Nodal à chaque étape, un tour de CLI chaque
 * seconde, apps/runner/src/cli-runtime/run-job.ts).
 *
 * AUCUN ENFANT NE NAÎT APRÈS L'ANNULATION (revue Codex de #572, passe 3). Une
 * photo des descendants prise avant d'annuler laissait passer l'enfant qu'un
 * worker insérait juste après : il était absent de la photo, et il tournait. Le
 * protocole tient à deux gestes, dans le même ordre des deux côtés (job, puis
 * tâche : aucun interblocage) :
 *   - ici, l'arbre est VERROUILLÉ niveau par niveau (`FOR UPDATE`) avant la
 *     lecture du niveau suivant : une insertion en cours sous un job de l'arbre
 *     doit finir avant qu'on lise ses enfants, et chaque lecture est une
 *     nouvelle image (READ COMMITTED), qui la voit ;
 *   - `insertChildJob` prend le parent en `FOR SHARE` et refuse de faire
 *     naître un enfant sous un parent terminal : une insertion qui arrive après
 *     l'annulation attend la fin de cette transaction, puis la voit.
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
      .for('update');
    if (!target) return { jobIds: [], taskIds: [], requestIds: [], discardedMessages: [] };

    const ids = new Set([jobId]);
    let frontier = [jobId];
    // Borné par la profondeur de délégation (invariant #8) ; `ids` garde la
    // boucle finie même sur un graphe corrompu.
    //
    // La descente suit AUSSI `relaunched_from_job_id` (#531, revue de #642
    // passe 1) : la tête que la file d'un job a fait naître à sa fin est la
    // suite du même travail. Un Stop qui croise cette fin attend le verrou de
    // la cible, puis — chaque niveau est une instruction nouvelle — voit la
    // tête relancée et l'arrête : le travail ne repart pas derrière l'accusé.
    while (frontier.length > 0) {
      const rows = await t
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.entityId, entityId),
            or(
              inArray(agentJobs.parentJobId, frontier),
              inArray(agentJobs.relaunchedFromJobId, frontier),
            ),
          ),
        )
        .for('update');
      frontier = rows.map((r) => r.id).filter((id) => !ids.has(id));
      for (const id of frontier) ids.add(id);
    }
    const tree = [...ids];

    // La file des jobs arrêtés est lue sous le verrou pris plus haut, puis
    // vidée dans la MÊME instruction que le statut : le déclencheur de relance
    // (migration 0141) la voit vide et ne fait naître aucune tête. Arrêter,
    // c'est arrêter aussi ce qui attendait ce travail (#531).
    // Une tête relancée encore vivante porte, en tâche, un message qui
    // attendait : il est retiré lui aussi, et rendu.
    const queued = await t
      .select({
        id: agentJobs.id,
        task: agentJobs.task,
        relaunchedFromJobId: agentJobs.relaunchedFromJobId,
        inbox: agentJobs.inbox,
      })
      .from(agentJobs)
      .where(
        and(
          inArray(agentJobs.id, tree),
          eq(agentJobs.entityId, entityId),
          notTerminal(),
          or(sql`${agentJobs.inbox} <> '[]'::jsonb`, isNotNull(agentJobs.relaunchedFromJobId)),
        ),
      );
    const now = new Date();
    const jobs = await t
      .update(agentJobs)
      .set({ status: 'cancelled', updatedAt: now, inbox: sql`'[]'::jsonb` })
      .where(and(inArray(agentJobs.id, tree), eq(agentJobs.entityId, entityId), notTerminal()))
      .returning({ id: agentJobs.id });
    const tasks = await t
      .update(agentTasks)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          inArray(agentTasks.rootJobId, tree),
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
          inArray(approvalRequests.jobId, tree),
          eq(approvalRequests.entityId, entityId),
          eq(approvalRequests.status, 'pending'),
        ),
      )
      .returning({ id: approvalRequests.id });
    return {
      jobIds: jobs.map((r) => r.id),
      taskIds: tasks.map((r) => r.id),
      requestIds: requests.map((r) => r.id),
      discardedMessages: queued.flatMap((q) => [
        ...(q.relaunchedFromJobId !== null ? [{ jobId: q.id, task: q.task }] : []),
        ...q.inbox.map((e) => ({ jobId: q.id, task: e.task })),
      ]),
    };
  });
}

/** Pourquoi un enfant n'est pas né : la ligne qui l'a refusé, et ce qu'elle disait. */
export type ChildJobRefusal =
  | { readonly refused: 'parent_not_live'; readonly parentStatus: string | null }
  | { readonly refused: 'task_not_in_progress'; readonly taskStatus: string | null };

/**
 * LE seul chemin par lequel un job ENFANT naît (délégation `assign_*`, tâche du
 * tableau). L'enfant n'est inséré que si son parent vit encore — ni annulé, ni
 * fini, ni échoué — et, pour une tâche du tableau, que si la tâche est encore
 * `in_progress` (réclamée, pas annulée).
 *
 * Le parent est pris en `FOR SHARE`, puis la tâche en `FOR UPDATE`, dans la
 * transaction de l'insertion : `cancelJobTree` verrouille les jobs de l'arbre
 * avant les tâches, dans le même ordre. Une annulation et une naissance ne
 * peuvent donc que se sérialiser : l'annulation voit l'enfant né avant elle,
 * et la naissance qui arrive après elle voit le parent annulé.
 *
 * Rend la ligne insérée, ou le refus : jamais une insertion en silence sous un
 * parent mort (invariant #4). À l'appelant de dire ce qu'il fait d'un refus.
 */
export async function insertChildJob(
  db: AnyDrizzleDb,
  values: typeof agentJobs.$inferInsert,
  opts: { taskId?: string } = {},
): Promise<{ job: typeof agentJobs.$inferSelect } | ChildJobRefusal> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    if (values.parentJobId) {
      const [parent] = await t
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, values.parentJobId))
        .for('share');
      const status = parent ? (parent.status ?? 'pending') : null;
      if (status === null || (TERMINAL_STATUSES as readonly string[]).includes(status)) {
        return { refused: 'parent_not_live', parentStatus: status } as const;
      }
    }
    if (opts.taskId) {
      const [task] = await t
        .select({ status: agentTasks.status })
        .from(agentTasks)
        .where(eq(agentTasks.id, opts.taskId))
        .for('update');
      if (task?.status !== 'in_progress') {
        return { refused: 'task_not_in_progress', taskStatus: task?.status ?? null } as const;
      }
    }
    const [job] = await t.insert(agentJobs).values(values).returning();
    if (!job) throw new Error('insertChildJob: the child job row was not returned');
    return { job };
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

/** Un run que l'arrêt a trouvé vivant, et ce qu'il y a changé. */
export interface StoppedRun extends CancelledTree {
  /** La tête du run : l'identifiant que `listConversationRuns` rend. */
  readonly runId: string;
}

/** Ce qu'un arrêt de runs a fait, run par run. */
export interface StoppedRuns {
  readonly stopped: StoppedRun[];
  /** Les runs visés où rien ne vivait plus : rien n'y a été changé. */
  readonly alreadyFinished: string[];
}

/**
 * Arrête ces runs, chacun par `cancelJobTree` — la cascade du bouton Stop.
 * Un run où rien ne vivait plus est rendu à part, jamais compté comme arrêté.
 */
export async function stopRuns(
  db: AnyDrizzleDb,
  input: { entityId: string; runIds: readonly string[] },
): Promise<StoppedRuns> {
  const stopped: StoppedRun[] = [];
  const alreadyFinished: string[] = [];
  for (const runId of input.runIds) {
    const c = await cancelJobTree(db, { entityId: input.entityId, jobId: runId });
    if (c.jobIds.length === 0 && c.taskIds.length === 0 && c.requestIds.length === 0) {
      alreadyFinished.push(runId);
    } else {
      stopped.push({ runId, ...c });
    }
  }
  return { stopped, alreadyFinished };
}

/**
 * Arrête TOUS les runs vivants d'une conversation (#602) : ceux que
 * `listConversationRuns` lit, arrêtés par `stopRuns`. Une seule définition de
 * « les runs de cette conversation » pour les deux gestes qui l'arrêtent :
 * l'outil `stop_conversation_run` (le modèle choisit de l'appeler) et la
 * commande `/stop` d'un canal (la plateforme la traite, aucun modèle n'y a part).
 */
export async function stopConversationRuns(
  db: AnyDrizzleDb,
  input: { entityId: string; conversationId: string; excludeHeadJobId?: string },
): Promise<StoppedRuns> {
  const runs = await listConversationRuns(db, input);
  return stopRuns(db, { entityId: input.entityId, runIds: runs.map((r) => r.headJobId) });
}
