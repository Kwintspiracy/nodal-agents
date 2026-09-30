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
//     relancer, et le rend ;
//   - une entrée dont le canal télécharge encore le média n'est lue qu'une
//     fois complète.
//
// Une tête SUSPENDUE (approbation, délégation) est vivante : le message y
// attend, accusé tout de suite par le canal, et il est lu à la reprise —
// décision produit validée par Quentin (#642). `/stop` et `/new` restent les
// sorties immédiates.
//
// Aucun texte n'est écrit par la plateforme : le message est celui de la
// personne, et le canal accuse réception par une réaction (invariant #2).

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { INBOX_MEDIA_WAIT_MS, LIVE_JOB_STATUSES, inboxMessage } from '@nodal-agents/shared';
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
 * LE point de décision : remet `message` à la tête vivante de la conversation,
 * ou démarre `start` s'il n'y en a aucune.
 *
 * SÉRIALISÉ PAR CONVERSATION (revue de #642, passe 1). Trois courses, fermées
 * chacune par un geste, sur un vrai Postgres à deux connexions
 * (conversation-inbox-race.pg.test.ts) :
 *   - deux messages qui démarrent en même temps : le verrou consultatif de la
 *     conversation (`pg_advisory_xact_lock`) les fait passer l'un après
 *     l'autre, et le second voit la tête du premier ;
 *   - un message qui croise la fin de la tête : la tête est prise en
 *     `FOR UPDATE`, la fin l'attend (et le déclencheur relance l'entrée) ou
 *     elle a gagné — et si sa file n'était pas vide, le déclencheur a fait
 *     naître une tête que la lecture verrouillée, prise sur l'image d'AVANT,
 *     ne voit pas. D'où la RELECTURE : une instruction nouvelle voit ce qui a
 *     été commité pendant l'attente, et le message va à cette tête-là ;
 *   - l'arrêt qui croise la fin de la tête : `cancelJobTree` descend aussi par
 *     `relaunched_from_job_id`, la tête née de la file étant la suite du même
 *     travail.
 * Le déclencheur, lui, ne prend PAS le verrou consultatif : il tourne sous le
 * verrou de ligne que pose l'écriture terminale, alors que la décision prend
 * le verrou consultatif avant la ligne — le prendre là-bas inverserait l'ordre
 * et ferait des interblocages. La relecture ci-dessus rend ce verrou inutile.
 *
 * Plusieurs têtes vivantes (un fil d'avant cette règle) : la plus récente
 * reçoit le message, c'est le travail dont la personne parle.
 */
export async function deliverOrStartTurn(
  db: AnyDrizzleDb,
  input: {
    entityId: string;
    conversationId: string;
    /**
     * `preparing` : le canal attache encore un média à ce message, hors
     * transaction ; une entrée remise n'est pas lue avant qu'il soit là
     * (`attachToInboxEntry`, `releaseInboxEntry`).
     */
    message: { task: string; content: InboxContent; preparing?: boolean };
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
      const [head] = await t
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(heads)
        .orderBy(desc(agentJobs.createdAt), desc(agentJobs.id))
        .limit(1)
        .for('update');

      if (head) {
        const entry: InboxEntry = {
          id: crypto.randomUUID(),
          task: message.task,
          content: message.content,
          receivedAt: new Date().toISOString(),
          ...(message.preparing ? { preparing: true } : {}),
        };
        const [delivered] = await t
          .update(agentJobs)
          .set({ inbox: sql`${agentJobs.inbox} || ${JSON.stringify([entry])}::jsonb` })
          .where(and(eq(agentJobs.id, head.id), live()))
          .returning({ id: agentJobs.id });
        if (!delivered) {
          // Verrouillée et relue vivante juste au-dessus : ne peut pas arriver.
          throw new Error(`deliverOrStartTurn: head ${head.id} left before the delivery`);
        }
        return { kind: 'delivered', headJobId: head.id, entryId: entry.id } as const;
      }

      // Rien sous verrou. Une instruction NOUVELLE (nouvelle image, READ
      // COMMITTED) : une tête commitée pendant l'attente du verrou — celle que
      // le déclencheur fait naître d'une file non vide — est vue ici.
      const [born] = await t.select({ id: agentJobs.id }).from(agentJobs).where(heads).limit(1);
      if (born) continue;

      const [job] = await t.insert(agentJobs).values(start).returning({ id: agentJobs.id });
      if (!job) throw new Error('deliverOrStartTurn: the job row was not returned');
      return { kind: 'started', jobId: job.id } as const;
    }
    throw new Error(
      `deliverOrStartTurn: the heads of conversation ${conversationId} kept changing while it was read`,
    );
  });
}

/** Ce que le vidage a rendu, et ce qu'il a laissé parce que son média arrive encore. */
export interface DrainedInbox {
  readonly messages: InboxMessage[];
  /** Entrées laissées en file : leur média est en cours de téléchargement. */
  readonly preparing: number;
}

/** Une entrée se lit-elle maintenant ? Oui, sauf un média attendu depuis moins de `INBOX_MEDIA_WAIT_MS`. */
function readable(entry: InboxEntry, now: number): boolean {
  if (!entry.preparing) return true;
  const received = Date.parse(entry.receivedAt);
  return !Number.isFinite(received) || now - received >= INBOX_MEDIA_WAIT_MS;
}

/**
 * Vide la file du job que CE run tient (sous sa prise, #566) et rend ce qu'elle
 * contenait, prêt à entrer dans la transcription (marqué, `inboxMessage`).
 *
 * Une entrée dont le média se télécharge encore (`preparing`) RESTE en file et
 * est comptée : elle n'est lue qu'une fois complète (revue de #642, passe 1).
 * Au-delà de `INBOX_MEDIA_WAIT_MS`, elle est lue telle qu'elle est.
 *
 * Les messages lus sont aussi ajoutés à `messages` en base dans la même
 * transaction : entre le vidage et le point de reprise suivant, ils ne vivent
 * pas que dans la mémoire du run.
 *
 * Rend une file vide quand il n'y a rien, et quand le run ne tient plus le
 * job : ce n'est pas à lui de la lire, la transition terminale s'en chargera.
 */
export async function drainJobInbox(db: AnyDrizzleDb, jobId: string): Promise<DrainedInbox> {
  // Une lecture sans verrou d'abord : la file est vide à presque tous les tours.
  const [peek] = await db
    .select({ n: sql<number>`jsonb_array_length(${agentJobs.inbox})` })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!peek || Number(peek.n) === 0) return { messages: [], preparing: 0 };

  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    const [row] = await t
      .select({ inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(ownJobRow(jobId, RUN_ACTS_WHILE))
      .for('update');
    const entries = row?.inbox ?? [];
    const now = Date.now();
    const ready = entries.filter((e) => readable(e, now));
    const waiting = entries.filter((e) => !readable(e, now));
    if (ready.length === 0) return { messages: [], preparing: waiting.length };
    const drained = ready.map(inboxMessage);
    await t
      .update(agentJobs)
      .set({
        inbox: sql`${JSON.stringify(waiting)}::jsonb`,
        messages: sql`COALESCE(${agentJobs.messages}, '[]'::jsonb) || ${JSON.stringify(drained)}::jsonb`,
      })
      .where(ownJobRow(jobId, RUN_ACTS_WHILE));
    return { messages: drained, preparing: waiting.length };
  });
}

/**
 * Réécrit l'entrée `entryId`, où qu'elle attende dans l'espace `entityId` :
 * dans la file de la tête qui l'a reçue, ou dans celle de la tête que le
 * déclencheur a relancée. Rend `false` quand l'entrée n'est plus dans aucune
 * file (lue, ou devenue la tâche d'une tête relancée).
 */
async function rewriteInboxEntry(
  db: AnyDrizzleDb,
  input: { entityId: string; entryId: string; patch: Record<string, unknown> },
): Promise<boolean> {
  const { entityId, entryId, patch } = input;
  const rows = await db
    .update(agentJobs)
    .set({
      inbox: sql`(
        SELECT jsonb_agg(
          CASE WHEN e ->> 'id' = ${entryId}
            THEN (e - 'preparing') || ${JSON.stringify(patch)}::jsonb
            ELSE e END
          ORDER BY ord)
        FROM jsonb_array_elements(${agentJobs.inbox}) WITH ORDINALITY AS x(e, ord)
      )`,
    })
    .where(
      and(
        eq(agentJobs.entityId, entityId),
        sql`${agentJobs.inbox} @> ${JSON.stringify([{ id: entryId }])}::jsonb`,
      ),
    )
    .returning({ id: agentJobs.id });
  return rows.length > 0;
}

/**
 * Rattache le contenu complet d'un message remis (l'image, téléchargée hors
 * transaction) à son entrée, et la rend lisible. `false` : l'entrée n'attend
 * plus dans aucune file — c'est à l'appelant de le dire.
 */
export function attachToInboxEntry(
  db: AnyDrizzleDb,
  input: { entityId: string; entryId: string; content: InboxContent },
): Promise<boolean> {
  return rewriteInboxEntry(db, {
    entityId: input.entityId,
    entryId: input.entryId,
    patch: { content: input.content },
  });
}

/**
 * Le téléchargement du média a échoué : l'entrée devient lisible telle qu'elle
 * est, texte seul, au lieu d'attendre `INBOX_MEDIA_WAIT_MS`.
 */
export function releaseInboxEntry(
  db: AnyDrizzleDb,
  input: { entityId: string; entryId: string },
): Promise<boolean> {
  return rewriteInboxEntry(db, { ...input, patch: {} });
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
