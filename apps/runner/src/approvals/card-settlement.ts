// approvals/card-settlement.ts — une carte d'approbation suit le sort de sa
// demande, sur tous les canaux, quel que soit le chemin qui l'a tranchée (#637).
//
// Avant : seul le clic SUR la carte la réécrivait. Une demande tranchée depuis
// le dashboard ou un autre canal, expirée par le balayage (cron/reset-orphans),
// ou close parce que son job ou son arbre avait été annulé (`cancelJobTree` :
// bouton Stop du web, `/stop` d'un canal) laissait chez le propriétaire une
// carte morte aux boutons encore actifs. Découvert sur un job lancé par le
// serveur MCP, dont la carte part sur Telegram (resolveTransportChannel) — mais
// rien là-dedans n'est propre au MCP ni à Telegram.
//
// La forme : UN point, qui ne connaît aucun des chemins. Il lit l'ÉTAT — les
// cartes consignées à l'envoi (notify.ts) dont la demande n'est plus `pending`
// et qui n'ont pas encore été mises à jour — et réécrit chacune sur son canal.
// Il est appelé :
//   - par `resolveApprovalDecision`, juste après la décision (toute réponse,
//     d'où qu'elle vienne, met sa carte à jour tout de suite) ;
//   - à chaque tick du cron, après l'expiration des demandes échues — ce qui
//     rattrape aussi toute demande close hors du runner (l'annulation depuis le
//     web) ou par un chemin futur que personne n'aura pensé à brancher ici.

import { claimSettledApprovalCards, getBindingCredentials } from '@nodal-agents/db';
import type { AnyDrizzleDb, SettledApprovalCard } from '@nodal-agents/db';
import { getAdapter, type ChannelKind } from '@nodal-agents/delivery';
import { settledApprovalCardText } from './notify.ts';

/** Ce que le point a fait de chaque carte réservée — rendu pour les tests et les logs. */
export type CardSettlementOutcome =
  | { cardId: string; approvalRequestId: string; channel: string; outcome: 'edited'; text: string }
  | {
      cardId: string;
      approvalRequestId: string;
      channel: string;
      outcome: 'cannot_edit' | 'no_credentials' | 'failed';
      detail: string;
    };

async function settleOne(
  db: AnyDrizzleDb,
  card: SettledApprovalCard,
): Promise<CardSettlementOutcome> {
  const base = {
    cardId: card.id,
    approvalRequestId: card.approvalRequestId,
    channel: card.channel,
  };
  const text = settledApprovalCardText(card);
  const adapter = getAdapter(card.channel as ChannelKind);
  if (!adapter.capabilities.editMessage || !adapter.editMessageText) {
    // Un canal qui ne sait pas réécrire un message envoyé (WhatsApp) : la carte
    // y reste telle qu'envoyée. Ce n'est pas tu (invariant #4).
    const detail =
      `${card.channel} cannot edit a sent message: the card for approval ` +
      `${card.approvalRequestId} (message ${card.messageId}) still reads as pending there, ` +
      `although the request is ${card.status}.`;
    console.warn(`[approval-card] ${detail}`);
    return { ...base, outcome: 'cannot_edit', detail };
  }
  const creds = await getBindingCredentials(db, card.agentId, card.channel);
  if (!creds) {
    const detail =
      `no usable ${card.channel} credentials left for agent ${card.agentId}: the card for ` +
      `approval ${card.approvalRequestId} (message ${card.messageId}) cannot be updated to "${text}".`;
    console.warn(`[approval-card] ${detail}`);
    return { ...base, outcome: 'no_credentials', detail };
  }
  await adapter.editMessageText(creds, card.conversationId, card.messageId, text);
  return { ...base, outcome: 'edited', text };
}

/**
 * Met à jour les cartes des demandes tranchées : texte final, boutons retirés,
 * sur chaque canal qui sait réécrire un message ; un log explicite pour les
 * autres. `approvalRequestIds` borne à ces demandes ; absent, toutes.
 *
 * Ne lève jamais : la décision est déjà écrite, une carte qui ne se met pas à
 * jour ne doit pas la défaire. Chaque échec est dit.
 */
export async function settleApprovalCards(
  db: AnyDrizzleDb,
  opts: { approvalRequestIds?: readonly string[] } = {},
): Promise<CardSettlementOutcome[]> {
  let cards: SettledApprovalCard[];
  try {
    cards = await claimSettledApprovalCards(db, opts);
  } catch (err) {
    console.warn(
      `[approval-card] could not read the cards to update: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const outcomes: CardSettlementOutcome[] = [];
  for (const card of cards) {
    try {
      outcomes.push(await settleOne(db, card));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[approval-card] card for approval ${card.approvalRequestId} on ${card.channel} ` +
          `(message ${card.messageId}) could not be updated: ${detail}`,
      );
      outcomes.push({
        cardId: card.id,
        approvalRequestId: card.approvalRequestId,
        channel: card.channel,
        outcome: 'failed',
        detail,
      });
    }
  }
  return outcomes;
}
