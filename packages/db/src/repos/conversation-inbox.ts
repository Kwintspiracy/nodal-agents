// repos/conversation-inbox.ts — un message qui arrive pendant que le travail
// de sa conversation tourne (#531).
//
// Le 23/09 (#453), puis sur chaque canal : une précision envoyée pendant que la
// première demande tournait (« et mets-le dans le dossier partagé ») démarrait
// un job de tête qui ne savait rien du travail en cours, et qui refaisait tout.
//
// LA RÈGLE (spécification de Quentin, 30/09) : un tel message n'est jamais sans
// réponse, et il n'est pas PRÉSUMÉ lié au travail en cours — il peut demander
// autre chose. Il démarre donc un TOUR DE RÉPONSE : un job du même agent,
// marqué `answers_while_job_id`, qui voit ce qui tourne (bloc « Work running in
// this conversation », conversation-id.ts) et décide avec de vrais outils :
// répondre, transmettre au travail en cours (`message_conversation_run` → la
// FILE du job visé), l'arrêter (`stop_conversation_run`), lancer autre chose.
//
// `startConversationTurn` est le point de décision, et le seul : les quatre
// canaux l'appellent par `takeChannelTurn`, le chat web par son `run_task`.
//
// La file (`agent_jobs.inbox`) d'un job vivant :
//   - sa boucle la vide en haut de chaque tour et avant de conclure sur une
//     réponse en texte (`drainJobInbox`) — avec ce qui restait dans la file de
//     ses descendants finis ;
//   - AUCUNE file ne reste sur un job terminal (déclencheur
//     `agent_jobs_inbox_relaunch`, migration 0141) : ce qui reste à un job qui
//     finit est lu par son premier ancêtre vivant, ou, s'il n'y en a aucun,
//     devient une nouvelle tête — c'est aussi le chemin d'un job de CLI, qui
//     n'a pas de frontière de tour ;
//   - l'arrêt demandé par la personne (`cancelJobTree`) la vide sans la
//     relancer, et le rend.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { LIVE_JOB_STATUSES, inboxMessage } from '@nodal-agents/shared';
import type { InboxEntry, InboxMessage } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { ownJobRow, RUN_ACTS_WHILE } from './run-claim.ts';
import { liveJob } from './conversation-runs.ts';

/** Ce qu'a démarré un message qui arrive dans une conversation. */
export interface ConversationTurn {
  readonly jobId: string;
  /**
   * Le travail vivant pendant lequel ce tour de réponse est né : la tête
   * vivante la plus récente, sinon le job vivant le plus récent (un délégué
   * dont la tête a fini). `null` : la conversation était au repos.
   */
  readonly answersWhileJobId: string | null;
}

/**
 * LE point de décision : démarre `start` dans la conversation — comme tour de
 * réponse (`answers_while_job_id`) si du travail y tourne, sinon comme tête
 * d'une conversation au repos.
 *
 * « Du travail tourne » : N'IMPORTE QUEL job vivant de la conversation, tête
 * ou délégué (revue de #642, passe 2). Un délégué qui tourne encore sous une
 * tête finie est du travail en cours : le message qui arrive doit le voir.
 *
 * SÉRIALISÉ PAR CONVERSATION, sur un vrai Postgres à deux connexions
 * (conversation-inbox-race.pg.test.ts) : le verrou consultatif de la
 * conversation (`pg_advisory_xact_lock`), que le déclencheur de fin de job
 * (migration 0141) prend aussi. Deux messages simultanés passent l'un après
 * l'autre, et le second voit le job du premier ; un message qui croise la fin
 * d'un job voit l'état d'avant (et répond pendant ce job) ou l'état d'après
 * (et répond pendant la tête que la file a fait naître) — jamais un entre-deux.
 * Aucun verrou de ligne n'est pris ici : personne ne tient ce verrou en
 * attendant une ligne, donc aucun interblocage avec le déclencheur, qui le
 * prend sous le verrou de ligne de l'écriture terminale.
 *
 * Pas d'emballement : un tour de réponse ne naît QUE d'un message. Un message
 * qui arrive pendant un tour de réponse suit la même règle — un tour de plus,
 * un seul, pour ce message.
 */
export async function startConversationTurn(
  db: AnyDrizzleDb,
  input: {
    entityId: string;
    conversationId: string;
    /** Le job à démarrer, dans cette conversation. */
    start: typeof agentJobs.$inferInsert;
  },
): Promise<ConversationTurn> {
  const { entityId, conversationId, start } = input;
  if (
    start.conversationId !== conversationId ||
    start.entityId !== entityId ||
    (start.parentJobId ?? null) !== null
  ) {
    throw new Error(
      'startConversationTurn: the job to start must be a head of the same entity and conversation',
    );
  }
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    await t.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`nodal:conversation-turn:${conversationId}`}))`,
    );
    // La tête vivante la plus récente d'abord — le travail dont la personne
    // parle le plus probablement —, sinon le job vivant le plus récent. Le
    // tour de réponse voit de toute façon TOUT ce qui tourne.
    const [running] = await t
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, entityId),
          eq(agentJobs.conversationId, conversationId),
          liveJob(),
        ),
      )
      .orderBy(
        sql`(${agentJobs.parentJobId} IS NULL) DESC`,
        desc(agentJobs.createdAt),
        desc(agentJobs.id),
      )
      .limit(1);
    const answersWhileJobId = running?.id ?? null;
    const [job] = await t
      .insert(agentJobs)
      .values({ ...start, answersWhileJobId })
      .returning({ id: agentJobs.id });
    if (!job) throw new Error('startConversationTurn: the job row was not returned');
    return { jobId: job.id, answersWhileJobId };
  });
}

/** Ce que la remise d'un message à un job vivant a donné. */
export type ConversationJobDelivery =
  | { readonly delivered: true; readonly jobId: string; readonly entryId: string }
  | {
      readonly delivered: false;
      /** `not_in_conversation` : ce job n'est pas de cette conversation ; `not_live` : il a fini. */
      readonly reason: 'not_in_conversation' | 'not_live';
      readonly status: string | null;
    };

/**
 * Écrit `text` dans la file du job `jobId` — une tête ou un délégué de la
 * conversation `conversationId`, encore vivant. Il la lira à son prochain tour,
 * et avant de conclure. La ligne est verrouillée : une fin concurrente
 * l'attend et voit l'entrée (une tête la relance, un délégué la laisse à son
 * parent), ou elle a gagné et la remise est refusée — jamais une entrée écrite
 * dans la file d'un job fini.
 */
export async function deliverToConversationJob(
  db: AnyDrizzleDb,
  input: {
    entityId: string;
    conversationId: string;
    jobId: string;
    text: string;
    /** Le job qui transmet, s'il y en a un. */
    fromJobId?: string;
  },
): Promise<ConversationJobDelivery> {
  const { entityId, conversationId, jobId, text } = input;
  if (text.trim() === '') throw new Error('deliverToConversationJob: the message has no text');
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [row] = await t
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.id, jobId),
          eq(agentJobs.entityId, entityId),
          eq(agentJobs.conversationId, conversationId),
        ),
      )
      .for('update');
    if (!row) return { delivered: false, reason: 'not_in_conversation', status: null } as const;
    if (row.status === null || !(LIVE_JOB_STATUSES as readonly string[]).includes(row.status)) {
      return { delivered: false, reason: 'not_live', status: row.status } as const;
    }
    const entry: InboxEntry = {
      id: crypto.randomUUID(),
      task: text,
      content: text,
      receivedAt: new Date().toISOString(),
      ...(input.fromJobId ? { fromJobId: input.fromJobId } : {}),
    };
    await t
      .update(agentJobs)
      .set({ inbox: sql`${agentJobs.inbox} || ${JSON.stringify([entry])}::jsonb` })
      .where(eq(agentJobs.id, jobId));
    return { delivered: true, jobId, entryId: entry.id } as const;
  });
}

/**
 * Vide la file du job que CE run tient (sous sa prise, #566) et rend ce qu'elle
 * contenait, prêt à entrer dans la transcription (marqué, `inboxMessage`) —
 * avec ce qui restait dans la file de ses descendants FINIS, à toute
 * profondeur : un message transmis à un délégué qui a terminé avant de le lire
 * revient à son premier ancêtre vivant (le déclencheur de fin de job le lui
 * laisse), qui le lit ici. Ancêtre puis descendants : l'ordre de verrous de
 * l'arrêt (`cancelJobTree`).
 *
 * Les messages sont aussi ajoutés à `messages` en base dans la même
 * transaction : entre le vidage et le point de reprise suivant, ils ne vivent
 * pas que dans la mémoire du run.
 *
 * Rend `[]` quand il n'y a rien, et quand le run ne tient plus le job : ce
 * n'est pas à lui de la lire, la transition terminale s'en chargera.
 */
export async function drainJobInbox(db: AnyDrizzleDb, jobId: string): Promise<InboxMessage[]> {
  // Les descendants FINIS de ce job, à toute profondeur, en ne traversant que
  // des jobs finis : un descendant encore vivant lit lui-même sa file et celle
  // des siens.
  const finishedDescendants = sql`(
    WITH RECURSIVE finished AS (
      SELECT c.id FROM agent_jobs c
      WHERE c.parent_job_id = ${jobId} AND c.status IN ('completed', 'failed', 'cancelled')
      UNION ALL
      SELECT c.id FROM agent_jobs c JOIN finished f ON c.parent_job_id = f.id
      WHERE c.status IN ('completed', 'failed', 'cancelled')
    )
    SELECT id FROM finished
  )`;
  // Une lecture sans verrou d'abord : il n'y a rien à presque tous les tours.
  const [peek] = await db
    .select({
      own: sql<number>`jsonb_array_length(${agentJobs.inbox})`,
      descendants: sql<number>`(
        SELECT count(*) FROM agent_jobs d
        WHERE d.id IN ${finishedDescendants} AND d.inbox <> '[]'::jsonb
      )`,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!peek || (Number(peek.own) === 0 && Number(peek.descendants) === 0)) return [];

  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [row] = await t
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(ownJobRow(jobId, RUN_ACTS_WHILE))
      .for('update');
    if (!row) return [];
    const descendants = await t
      .select({ id: agentJobs.id, inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(
        and(sql`${agentJobs.id} IN ${finishedDescendants}`, sql`${agentJobs.inbox} <> '[]'::jsonb`),
      )
      .orderBy(agentJobs.createdAt)
      .for('update');
    const entries = [...row.inbox, ...descendants.flatMap((d) => d.inbox)];
    if (entries.length === 0) return [];
    const drained = entries.map(inboxMessage);
    await t
      .update(agentJobs)
      .set({
        inbox: sql`'[]'::jsonb`,
        messages: sql`COALESCE(${agentJobs.messages}, '[]'::jsonb) || ${JSON.stringify(drained)}::jsonb`,
      })
      .where(ownJobRow(jobId, RUN_ACTS_WHILE));
    if (descendants.length > 0) {
      await t
        .update(agentJobs)
        .set({ inbox: sql`'[]'::jsonb` })
        .where(
          inArray(
            agentJobs.id,
            descendants.map((d) => d.id),
          ),
        );
    }
    return drained;
  });
}

/**
 * Les têtes en attente (`pending`) de la conversation de `jobId` — celles que
 * la fin de ce job a pu faire naître de sa file, à réveiller tout de suite.
 */
export async function pendingHeadsOfConversation(
  db: AnyDrizzleDb,
  jobId: string,
): Promise<string[]> {
  const [job] = await db
    .select({ entityId: agentJobs.entityId, conversationId: agentJobs.conversationId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!job?.conversationId || !job.entityId) return [];
  const rows = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.entityId, job.entityId),
        eq(agentJobs.conversationId, job.conversationId),
        isNull(agentJobs.parentJobId),
        eq(agentJobs.status, 'pending'),
      ),
    );
  return rows.map((r) => r.id);
}
