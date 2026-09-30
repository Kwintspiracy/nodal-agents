// repos/approval-cards.ts — les cartes d'approbation livrées sur un canal, et
// leur mise à jour quand la demande est tranchée (#637).
//
// Une demande quitte `pending` par plusieurs chemins : une réponse (dashboard,
// n'importe quel canal), l'expiration par le balayage, l'annulation de son job
// ou de son arbre (`cancelJobTree`, appelé par le web ET par le runner). Aucun
// de ces chemins n'a à savoir qu'une carte existe : la carte suit l'ÉTAT de la
// ligne, pas le geste qui l'a changé. D'où la forme de `claimSettledApprovalCards` :
// elle prend toutes les cartes pas encore mises à jour dont la demande n'est
// plus `pending`, quel que soit le chemin qui l'y a menée.

import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { approvalCardMessages, approvalRequests } from '../schema/approvals.ts';

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

/** Une carte à mettre à jour, avec ce que sa demande est devenue. */
export interface SettledApprovalCard {
  id: string;
  approvalRequestId: string;
  channel: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  status: string;
  kind: string;
  toolName: string;
  answer: string | null;
}

/**
 * Réserve, en une écriture, les cartes pas encore mises à jour dont la demande
 * a quitté `pending`, et les rend avec l'état de leur demande. `settled_at` est
 * posé AVANT l'édition : deux appelants concurrents (la réponse et le balayage)
 * ne réécrivent jamais la même carte deux fois — le second ne la voit plus.
 *
 * `approvalRequestIds` borne la réservation à ces demandes (le chemin d'une
 * réponse) ; absent, toutes les demandes sont concernées (le balayage).
 */
export async function claimSettledApprovalCards(
  db: AnyDrizzleDb,
  opts: { approvalRequestIds?: readonly string[] } = {},
): Promise<SettledApprovalCard[]> {
  if (opts.approvalRequestIds !== undefined && opts.approvalRequestIds.length === 0) return [];
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
    .set({ settledAt: new Date() })
    .where(
      and(
        isNull(approvalCardMessages.settledAt),
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
      status: approvalRequests.status,
      kind: approvalRequests.kind,
      toolName: approvalRequests.toolName,
      answer: approvalRequests.answer,
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
  // ici serait une ligne que la réservation n'aurait pas dû prendre.
  return rows.map((r) => {
    if (r.status === null) {
      throw new Error(`approval card ${r.id}: its request ${r.approvalRequestId} has no status`);
    }
    return { ...r, status: r.status };
  });
}
