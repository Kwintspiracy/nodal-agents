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
//     ses délégués finis ;
//   - ce qui reste quand une TÊTE finit devient une nouvelle tête (déclencheur
//     `agent_jobs_inbox_relaunch`, migration 0141) — c'est aussi le chemin d'un
//     job de CLI, qui n'a pas de frontière de tour ;
//   - l'arrêt demandé par la personne (`cancelJobTree`) la vide sans la
//     relancer, et le rend.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { LIVE_JOB_STATUSES, TERMINAL_STATUSES, inboxMessage } from '@nodal-agents/shared';
import type { InboxEntry, InboxMessage } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs } from '../schema/jobs.ts';
import { ownJobRow, RUN_ACTS_WHILE } from './run-claim.ts';

/** Ce qu'a démarré un message qui arrive dans une conversation. */
export interface ConversationTurn {
  readonly jobId: string;
  /** La tête vivante pendant laquelle ce tour de réponse est né ; `null` : la conversation était au repos. */
  readonly answersWhileJobId: string | null;
}

/**
 * « Vivant » : la définition partagée (`LIVE_JOB_STATUSES`), celle des
 * faucheurs et du déclencheur de relance — un job qui tourne ou qui attend ce
 * qui le fera repartir. Aucun écrivain ne pose de statut NULL (défaut
 * `pending`) : une ligne sans statut n'est vivante pour aucun chemin, ici non
 * plus (revue de #642, passe 1).
 */
function live() {
  return inArray(agentJobs.status, [...LIVE_JOB_STATUSES]);
}

/**
 * Combien de fois la décision relit la conversation quand une tête y est née
 * pendant qu'elle attendait. Une relecture suffit dans tous les cas connus ;
 * au-delà, la conversation change plus vite qu'on ne la lit, et c'est dit.
 */
const MAX_DECISION_READS = 5;

/**
 * LE point de décision : démarre `start` dans la conversation — comme tour de
 * réponse (`answers_while_job_id`) si une tête y vit, sinon comme tête d'une
 * conversation au repos.
 *
 * SÉRIALISÉ PAR CONVERSATION (revue de #642, passe 1), sur un vrai Postgres à
 * deux connexions (conversation-inbox-race.pg.test.ts) :
 *   - deux messages simultanés : le verrou consultatif de la conversation
 *     (`pg_advisory_xact_lock`) les fait passer l'un après l'autre, et le
 *     second voit la tête du premier — il répond PENDANT elle au lieu de
 *     démarrer une seconde tête « au repos » ;
 *   - un message qui croise la fin de la tête : la tête vivante est lue en
 *     `FOR UPDATE`. Si la fin l'emporte et que sa file n'était pas vide, le
 *     déclencheur a fait naître une tête que la lecture verrouillée, prise sur
 *     l'image d'AVANT, ne voit pas : une instruction NOUVELLE relit donc la
 *     conversation, et le tour répond pendant cette tête-là.
 * Le déclencheur ne prend PAS le verrou consultatif : il tourne sous le verrou
 * de ligne que pose l'écriture terminale, alors que la décision prend le
 * verrou consultatif avant la ligne — l'y prendre inverserait l'ordre et
 * ferait des interblocages. La relecture rend ce verrou inutile là-bas.
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
    const heads = and(
      eq(agentJobs.entityId, entityId),
      eq(agentJobs.conversationId, conversationId),
      isNull(agentJobs.parentJobId),
      live(),
    );
    for (let read = 0; read < MAX_DECISION_READS; read++) {
      // La tête la plus récente : le travail dont la personne parle le plus
      // probablement. Le tour de réponse voit de toute façon TOUT ce qui tourne.
      const [head] = await t
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(heads)
        .orderBy(desc(agentJobs.createdAt), desc(agentJobs.id))
        .limit(1)
        .for('update');
      if (!head) {
        // Rien sous verrou. Une instruction NOUVELLE (nouvelle image, READ
        // COMMITTED) : une tête commitée pendant l'attente du verrou — celle
        // que le déclencheur fait naître d'une file non vide — est vue ici.
        const [born] = await t.select({ id: agentJobs.id }).from(agentJobs).where(heads).limit(1);
        if (born) continue;
      }
      const answersWhileJobId = head?.id ?? null;
      const [job] = await t
        .insert(agentJobs)
        .values({ ...start, answersWhileJobId })
        .returning({ id: agentJobs.id });
      if (!job) throw new Error('startConversationTurn: the job row was not returned');
      return { jobId: job.id, answersWhileJobId };
    }
    throw new Error(
      `startConversationTurn: the heads of conversation ${conversationId} kept changing while it was read`,
    );
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
 * avec ce qui restait dans la file de ses délégués FINIS : un message transmis
 * à un délégué qui a terminé avant de le lire revient au parent, qui reprend
 * justement la main à ce moment-là. Parent puis enfants : l'ordre de verrous
 * de l'arrêt (`cancelJobTree`).
 *
 * Les messages sont aussi ajoutés à `messages` en base dans la même
 * transaction : entre le vidage et le point de reprise suivant, ils ne vivent
 * pas que dans la mémoire du run.
 *
 * Rend `[]` quand il n'y a rien, et quand le run ne tient plus le job : ce
 * n'est pas à lui de la lire, la transition terminale s'en chargera.
 */
export async function drainJobInbox(db: AnyDrizzleDb, jobId: string): Promise<InboxMessage[]> {
  // Une lecture sans verrou d'abord : il n'y a rien à presque tous les tours.
  const [peek] = await db
    .select({
      own: sql<number>`jsonb_array_length(${agentJobs.inbox})`,
      children: sql<number>`(
        SELECT count(*) FROM agent_jobs c
        WHERE c.parent_job_id = ${jobId} AND c.inbox <> '[]'::jsonb
      )`,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!peek || (Number(peek.own) === 0 && Number(peek.children) === 0)) return [];

  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [row] = await t
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(ownJobRow(jobId, RUN_ACTS_WHILE))
      .for('update');
    if (!row) return [];
    const children = await t
      .select({ id: agentJobs.id, inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.parentJobId, jobId),
          inArray(agentJobs.status, [...TERMINAL_STATUSES]),
          sql`${agentJobs.inbox} <> '[]'::jsonb`,
        ),
      )
      .orderBy(agentJobs.createdAt)
      .for('update');
    const entries = [...row.inbox, ...children.flatMap((c) => c.inbox)];
    if (entries.length === 0) return [];
    const drained = entries.map(inboxMessage);
    await t
      .update(agentJobs)
      .set({
        inbox: sql`'[]'::jsonb`,
        messages: sql`COALESCE(${agentJobs.messages}, '[]'::jsonb) || ${JSON.stringify(drained)}::jsonb`,
      })
      .where(ownJobRow(jobId, RUN_ACTS_WHILE));
    if (children.length > 0) {
      await t
        .update(agentJobs)
        .set({ inbox: sql`'[]'::jsonb` })
        .where(
          inArray(
            agentJobs.id,
            children.map((c) => c.id),
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
