// repos/conversation-inbox.ts — UN travail de tête par conversation (#531).
//
// Le 23/09 (#453), puis sur chaque canal : une précision envoyée pendant que la
// première demande tournait (« et mets-le dans le dossier partagé ») démarrait
// un second job de tête, qui refaisait tout. Sur les canaux, chaque message
// insérait sa tête ; sur le web, `run_task` était refusé au modèle, et la
// précision n'atteignait jamais le travail en cours.
//
// LA RÈGLE, pour toute entrée qui démarre du travail dans une conversation :
// tant qu'une tête de cette conversation n'est pas terminale — en cours, en
// attente d'une approbation ou d'une délégation, ou pas encore prise —, le
// message va dans SA file (`agent_jobs.inbox`) ; sinon il démarre une tête,
// comme avant. `deliverOrStartTurn` est ce point de décision, et le seul : les
// quatre canaux l'appellent par `takeChannelTurn`, le chat web par son
// `run_task`.
//
// Ce que devient une entrée :
//   - la boucle la vide en haut de chaque tour et avant de conclure sur une
//     réponse en texte (`drainJobInbox`) : le modèle la lit dans le travail
//     qu'elle concerne, et c'est lui qui juge — précision, ou autre travail
//     qu'il délègue ;
//   - ce qui reste quand la tête finit devient une nouvelle tête (déclencheur
//     `agent_jobs_inbox_relaunch`, migration 0141) — c'est aussi le chemin d'un
//     job de CLI, qui n'a pas de frontière de tour ;
//   - l'arrêt demandé par la personne (`cancelJobTree`) la vide sans la
//     relancer, et le rend.
//
// Aucun texte n'est écrit par la plateforme : le message est celui de la
// personne, et le canal accuse réception par une réaction (invariant #2).

import { and, desc, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import { TERMINAL_STATUSES, inboxMessage } from '@nodal-agents/shared';
import type { InboxContent, InboxEntry, InboxMessage } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { ownJobRow, RUN_ACTS_WHILE } from './run-claim.ts';

/** Ce qu'est devenu un message qui aurait démarré du travail. */
export type ConversationTurn =
  /** Aucune tête ne vivait : le message a démarré ce job. */
  | { readonly kind: 'started'; readonly jobId: string }
  /** Une tête vivait : le message est dans sa file. */
  | { readonly kind: 'delivered'; readonly headJobId: string; readonly entryId: string };

function notTerminal() {
  // `NULL NOT IN (…)` vaut « inconnu » et exclurait la ligne : une tête sans
  // statut n'a pas fini (même lecture que conversation-runs.ts).
  return or(isNull(agentJobs.status), notInArray(agentJobs.status, [...TERMINAL_STATUSES]));
}

/**
 * LE point de décision : remet `message` à la tête vivante de la conversation,
 * ou démarre `start` s'il n'y en a aucune.
 *
 * La tête est prise en `FOR UPDATE`, et l'entrée ajoutée sous ce verrou : une
 * transition terminale concurrente l'attend, puis voit l'entrée (et le
 * déclencheur la relance), ou elle a gagné, et la relecture sous verrou ne rend
 * plus cette tête — le message démarre alors la sienne. Plusieurs têtes
 * vivantes (un fil d'avant cette règle) : la plus récente reçoit le message,
 * c'est le travail dont la personne parle.
 */
export async function deliverOrStartTurn(
  db: AnyDrizzleDb,
  input: {
    entityId: string;
    conversationId: string;
    message: { task: string; content: InboxContent };
    /** Le job à démarrer quand rien ne vit, dans cette conversation. */
    start: typeof agentJobs.$inferInsert;
  },
): Promise<ConversationTurn> {
  const { entityId, conversationId, message, start } = input;
  if (start.conversationId !== conversationId || start.entityId !== entityId) {
    throw new Error(
      'deliverOrStartTurn: the job to start must belong to the same entity and conversation',
    );
  }
  if (message.task.trim() === '') {
    // La tâche d'une tête née de la file (déclencheur) : jamais vide.
    throw new Error('deliverOrStartTurn: the message has no text');
  }
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [head] = await t
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, entityId),
          eq(agentJobs.conversationId, conversationId),
          isNull(agentJobs.parentJobId),
          notTerminal(),
        ),
      )
      .orderBy(desc(agentJobs.createdAt), desc(agentJobs.id))
      .limit(1)
      .for('update');

    if (head) {
      const entry: InboxEntry = {
        id: crypto.randomUUID(),
        task: message.task,
        content: message.content,
        receivedAt: new Date().toISOString(),
      };
      const [delivered] = await t
        .update(agentJobs)
        .set({ inbox: sql`${agentJobs.inbox} || ${JSON.stringify([entry])}::jsonb` })
        .where(and(eq(agentJobs.id, head.id), notTerminal()))
        .returning({ id: agentJobs.id });
      if (!delivered) {
        // Verrouillée et relue vivante juste au-dessus : ne peut pas arriver.
        throw new Error(`deliverOrStartTurn: head ${head.id} left before the delivery`);
      }
      return { kind: 'delivered', headJobId: head.id, entryId: entry.id } as const;
    }

    const [job] = await t.insert(agentJobs).values(start).returning({ id: agentJobs.id });
    if (!job) throw new Error('deliverOrStartTurn: the job row was not returned');
    return { kind: 'started', jobId: job.id } as const;
  });
}

/**
 * Vide la file du job que CE run tient (sous sa prise, #566) et rend ce qu'elle
 * contenait, prêt à entrer dans la transcription (marqué, `inboxMessage`).
 *
 * Les messages sont aussi ajoutés à `messages` en base dans la même
 * transaction : entre le vidage et le point de reprise suivant, ils ne vivent
 * pas que dans la mémoire du run.
 *
 * Rend `[]` quand la file est vide, et quand le run ne tient plus le job : ce
 * n'est pas à lui de la lire, la transition terminale s'en chargera.
 */
export async function drainJobInbox(db: AnyDrizzleDb, jobId: string): Promise<InboxMessage[]> {
  // Une lecture sans verrou d'abord : la file est vide à presque tous les tours.
  const [peek] = await db
    .select({ n: sql<number>`jsonb_array_length(${agentJobs.inbox})` })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!peek || Number(peek.n) === 0) return [];

  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [row] = await t
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(ownJobRow(jobId, RUN_ACTS_WHILE))
      .for('update');
    const entries = row?.inbox ?? [];
    if (entries.length === 0) return [];
    const drained = entries.map(inboxMessage);
    await t
      .update(agentJobs)
      .set({
        inbox: sql`'[]'::jsonb`,
        messages: sql`COALESCE(${agentJobs.messages}, '[]'::jsonb) || ${JSON.stringify(drained)}::jsonb`,
      })
      .where(ownJobRow(jobId, RUN_ACTS_WHILE));
    return drained;
  });
}

/**
 * Rattache un contenu arrivé après coup (l'image d'un message, téléchargée
 * hors transaction) à l'entrée `entryId` de la file de `headJobId`, si elle y
 * est encore. Rend `false` quand l'entrée a déjà été vidée ou relancée :
 * c'est à l'appelant de le dire.
 */
export async function attachToInboxEntry(
  db: AnyDrizzleDb,
  input: { headJobId: string; entryId: string; content: InboxContent },
): Promise<boolean> {
  const { headJobId, entryId, content } = input;
  const rows = await db
    .update(agentJobs)
    .set({
      inbox: sql`(
        SELECT jsonb_agg(
          CASE WHEN e ->> 'id' = ${entryId}
            THEN jsonb_set(e, '{content}', ${JSON.stringify(content)}::jsonb)
            ELSE e END
          ORDER BY ord)
        FROM jsonb_array_elements(${agentJobs.inbox}) WITH ORDINALITY AS x(e, ord)
      )`,
    })
    .where(
      and(
        eq(agentJobs.id, headJobId),
        sql`${agentJobs.inbox} @> ${JSON.stringify([{ id: entryId }])}::jsonb`,
      ),
    )
    .returning({ id: agentJobs.id });
  return rows.length > 0;
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
