// repos/approval-cards.ts — les cartes d'approbation livrées sur un canal, et
// leur mise à jour quand la demande est tranchée (#637).
//
// Une demande quitte `pending` par plusieurs chemins : une réponse (dashboard,
// n'importe quel canal), l'expiration par le balayage, l'annulation de son job
// ou de son arbre (`cancelJobTree`, appelé par le web ET par le runner). Aucun
// de ces chemins n'a à savoir qu'une carte existe : la carte suit l'ÉTAT de la
// ligne, pas le geste qui l'a changé. D'où la forme de `claimSettledApprovalCards` :
// elle prend toutes les cartes pas encore finies dont la demande n'est plus
// `pending`, quel que soit le chemin qui l'y a menée.
//
// Une carte n'est déclarée finie (`settled_at` + `outcome`) qu'APRÈS son
// édition — jamais avant. Entre les deux, `claimed_at` est un bail : deux
// appelants concurrents (la réponse et le tick) n'éditent pas la même carte en
// même temps, et une carte prise par un processus mort est reprise.

import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { approvalCardMessages, approvalRequests } from '../schema/approvals.ts';

/** Durée du bail d'une carte prise pour édition. Bien au-delà d'une édition réelle. */
export const APPROVAL_CARD_CLAIM_LEASE_MS = 5 * 60_000;

export interface ApprovalCardMessageInput {
  approvalRequestId: string;
  channel: string;
  /** L'agent dont le binding a envoyé la carte (l'orchestrateur sur une chaîne déléguée). */
  agentId: string;
  conversationId: string;
  messageId: string;
}

/** Consigne une carte que l'on vient d'envoyer. */
export async function recordApprovalCardMessage(
  db: AnyDrizzleDb,
  input: ApprovalCardMessageInput,
): Promise<void> {
  await db.insert(approvalCardMessages).values(input);
}

/** Une carte prise pour édition, avec ce que sa demande est devenue. */
export interface SettledApprovalCard {
  id: string;
  approvalRequestId: string;
  channel: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  /** Tentatives, CELLE-CI comprise. */
  attempts: number;
  status: string;
  kind: string;
  toolName: string;
  answer: string | null;
  /** L'entité et l'agent de la DEMANDE (l'agent dont l'action était retenue). */
  requestEntityId: string | null;
  requestAgentId: string | null;
}

/**
 * Prend, en une écriture, les cartes pas encore finies dont la demande a
 * quitté `pending` et qu'aucun autre appelant ne tient (ou dont le bail a
 * expiré). Chaque prise compte une tentative. Rend les cartes avec l'état de
 * leur demande.
 *
 * `approvalRequestIds` borne la prise à ces demandes (le chemin d'une
 * réponse) ; absent, toutes les demandes sont concernées (le tick).
 */
export async function claimSettledApprovalCards(
  db: AnyDrizzleDb,
  opts: { approvalRequestIds?: readonly string[]; now?: Date } = {},
): Promise<SettledApprovalCard[]> {
  if (opts.approvalRequestIds !== undefined && opts.approvalRequestIds.length === 0) return [];
  const now = opts.now ?? new Date();
  const leaseExpired = new Date(now.getTime() - APPROVAL_CARD_CLAIM_LEASE_MS);
  const settledRequests = db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      opts.approvalRequestIds
        ? and(
            ne(approvalRequests.status, 'pending'),
            inArray(approvalRequests.id, [...opts.approvalRequestIds]),
          )
        : ne(approvalRequests.status, 'pending'),
    );
  const claimed = await db
    .update(approvalCardMessages)
    .set({ claimedAt: now, attempts: sql`${approvalCardMessages.attempts} + 1` })
    .where(
      and(
        isNull(approvalCardMessages.settledAt),
        or(
          isNull(approvalCardMessages.claimedAt),
          lt(approvalCardMessages.claimedAt, leaseExpired),
        ),
        inArray(approvalCardMessages.approvalRequestId, settledRequests),
      ),
    )
    .returning({ id: approvalCardMessages.id });
  if (claimed.length === 0) return [];

  const rows = await db
    .select({
      id: approvalCardMessages.id,
      approvalRequestId: approvalCardMessages.approvalRequestId,
      channel: approvalCardMessages.channel,
      agentId: approvalCardMessages.agentId,
      conversationId: approvalCardMessages.conversationId,
      messageId: approvalCardMessages.messageId,
      attempts: approvalCardMessages.attempts,
      status: approvalRequests.status,
      kind: approvalRequests.kind,
      toolName: approvalRequests.toolName,
      answer: approvalRequests.answer,
      requestEntityId: approvalRequests.entityId,
      requestAgentId: approvalRequests.agentId,
    })
    .from(approvalCardMessages)
    .innerJoin(approvalRequests, eq(approvalRequests.id, approvalCardMessages.approvalRequestId))
    .where(
      inArray(
        approvalCardMessages.id,
        claimed.map((c) => c.id),
      ),
    );
  // `ne(status, 'pending')` exclut déjà un statut NULL : une ligne sans statut
  // ici serait une ligne que la prise n'aurait pas dû prendre.
  return rows.map((r) => {
    if (r.status === null) {
      throw new Error(`approval card ${r.id}: its request ${r.approvalRequestId} has no status`);
    }
    return { ...r, status: r.status };
  });
}

/** L'issue finale d'une carte : elle ne sera plus reprise. */
export type ApprovalCardFinalOutcome = 'edited' | 'cannot_edit' | 'gave_up';

/**
 * Clôt une carte prise : `settled_at` + `outcome`, bail rendu. `lastError`
 * garde la raison d'un `cannot_edit` ou d'un `gave_up`.
 */
export async function finishApprovalCard(
  db: AnyDrizzleDb,
  cardId: string,
  outcome: ApprovalCardFinalOutcome,
  lastError: string | null = null,
): Promise<void> {
  await db
    .update(approvalCardMessages)
    .set({ settledAt: new Date(), outcome, claimedAt: null, lastError })
    .where(eq(approvalCardMessages.id, cardId));
}

/**
 * Rend une carte dont l'édition a échoué, SANS la clore : le bail est rendu,
 * la raison gardée, et le prochain appel (le tick suivant) la reprend.
 */
export async function releaseApprovalCardAfterFailure(
  db: AnyDrizzleDb,
  cardId: string,
  error: string,
): Promise<void> {
  await db
    .update(approvalCardMessages)
    .set({ claimedAt: null, lastError: error })
    .where(eq(approvalCardMessages.id, cardId));
}

/** Où est une carte : la demande, le canal, la conversation, le message. */
export interface ApprovalCardLocation {
  approvalRequestId: string;
  channel: string;
  agentId: string;
  conversationId: string;
  messageId: string;
}

/**
 * La ligne de CETTE carte, créée si elle manque — une carte envoyée avant la
 * table, ou dont l'enregistrement a échoué, entre ainsi dans le protocole au
 * premier clic. Rend son id.
 */
export async function adoptApprovalCard(
  db: AnyDrizzleDb,
  card: ApprovalCardLocation,
): Promise<string> {
  await db.insert(approvalCardMessages).values(card).onConflictDoNothing();
  const [row] = await db
    .select({ id: approvalCardMessages.id })
    .from(approvalCardMessages)
    .where(
      and(
        eq(approvalCardMessages.approvalRequestId, card.approvalRequestId),
        eq(approvalCardMessages.channel, card.channel),
        eq(approvalCardMessages.conversationId, card.conversationId),
        eq(approvalCardMessages.messageId, card.messageId),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`approval card for ${card.approvalRequestId} could not be adopted`);
  return row.id;
}

/**
 * Prend UNE carte pour l'afficher, sous le même bail que le règlement, SANS
 * compter de tentative (afficher une carte ouverte n'est pas régler). false :
 * la carte est finie, ou quelqu'un la tient.
 */
export async function claimApprovalCardForDisplay(
  db: AnyDrizzleDb,
  cardId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const leaseExpired = new Date(now.getTime() - APPROVAL_CARD_CLAIM_LEASE_MS);
  const rows = await db
    .update(approvalCardMessages)
    .set({ claimedAt: now })
    .where(
      and(
        eq(approvalCardMessages.id, cardId),
        isNull(approvalCardMessages.settledAt),
        or(
          isNull(approvalCardMessages.claimedAt),
          lt(approvalCardMessages.claimedAt, leaseExpired),
        ),
      ),
    )
    .returning({ id: approvalCardMessages.id });
  return rows.length > 0;
}

/** Rend le bail d'une carte prise pour affichage. */
export async function releaseApprovalCardClaim(db: AnyDrizzleDb, cardId: string): Promise<void> {
  await db
    .update(approvalCardMessages)
    .set({ claimedAt: null })
    .where(eq(approvalCardMessages.id, cardId));
}

/**
 * Remet dans la file de règlement les cartes d'une demande sur un canal (et,
 * si donnée, une conversation) : pas finies, essais remis à zéro. Un clic sur
 * une carte d'une demande déjà tranchée prouve que la carte montre encore des
 * boutons — qu'elle ait été abandonnée (`gave_up`), jamais consignée, ou
 * réécrite sans que ça tienne.
 */
export async function requeueApprovalCards(
  db: AnyDrizzleDb,
  where: { approvalRequestId: string; channel: string; conversationId?: string },
): Promise<number> {
  const rows = await db
    .update(approvalCardMessages)
    .set({ settledAt: null, outcome: null, attempts: 0, lastError: null })
    .where(
      and(
        eq(approvalCardMessages.approvalRequestId, where.approvalRequestId),
        eq(approvalCardMessages.channel, where.channel),
        where.conversationId !== undefined
          ? eq(approvalCardMessages.conversationId, where.conversationId)
          : undefined,
      ),
    )
    .returning({ id: approvalCardMessages.id });
  return rows.length;
}
