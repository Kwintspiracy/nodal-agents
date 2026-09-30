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
// et qui ne sont pas encore finies — et réécrit chacune sur son canal. C'est
// aussi le SEUL écrivain de la carte d'une demande tranchée : le clic sur la
// carte (Telegram, Discord, Slack) n'édite plus rien lui-même, il accuse
// réception et laisse ce point écrire, avec le même texte que partout.
//
// Il est appelé :
//   - par `resolveApprovalDecision`, juste après la décision (toute réponse,
//     d'où qu'elle vienne, met sa carte à jour tout de suite) ;
//   - à chaque tick du cron, après l'expiration des demandes échues — ce qui
//     rattrape toute demande close hors du runner (l'annulation depuis le web),
//     par un chemin futur, et toute édition qui a échoué.
//
// Une carte n'est déclarée finie qu'APRÈS une édition réussie (ou quand son
// canal ne sait pas éditer). Une édition ratée est reprise aux ticks suivants,
// `APPROVAL_CARD_MAX_ATTEMPTS` fois au plus, puis abandonnée — et c'est dit.

import {
  claimSettledApprovalCards,
  finishApprovalCard,
  releaseApprovalCardAfterFailure,
  getBindingCredentials,
  eq,
  approvalRequests,
  agents,
} from '@nodal-agents/db';
import type { SettledApprovalCard } from '@nodal-agents/db';
import { getAdapter, type ChannelKind } from '@nodal-agents/delivery';
import { isCodeExecutionTool } from '@nodal-agents/tools';
import { settledApprovalCardText } from './notify.ts';
import { getApprovalRule, isAutoRunPaused } from './rules.ts';
import type { RunnerDeps } from '../deps.ts';

/** Éditions tentées au plus pour une carte avant l'abandon (un tick de 120 s entre deux). */
export const APPROVAL_CARD_MAX_ATTEMPTS = 5;

type Db = RunnerDeps['db'];

/** Ce que le point a fait de chaque carte prise. */
export type CardSettlementOutcome = {
  cardId: string;
  approvalRequestId: string;
  channel: string;
} & (
  | { outcome: 'edited'; text: string }
  | { outcome: 'cannot_edit'; detail: string }
  /** L'édition a échoué ; la carte sera reprise au prochain appel. */
  | { outcome: 'will_retry'; detail: string; attempts: number }
  /** L'édition a échoué `APPROVAL_CARD_MAX_ATTEMPTS` fois : abandon. */
  | { outcome: 'gave_up'; detail: string; attempts: number }
);

/** Les faits d'une demande tranchée dont dépend le texte de sa carte. */
export interface SettledRequestFacts {
  status: string;
  kind: string;
  toolName: string;
  answer: string | null;
  entityId: string | null;
  agentId: string | null;
}

/**
 * LE texte de la carte d'une demande tranchée — lu en base, pour que tout
 * chemin qui réécrit une carte (ce point, et le clic Telegram qui arrive sur
 * une demande déjà tranchée) dise la même chose.
 *
 * Une demande approuvée dont l'outil est désormais couvert par une règle
 * `auto_approve` pour cet agent le dit : c'est un fait de la base, pas du
 * geste — le « Toujours autoriser » de la carte Telegram et celui du web
 * posent la même règle et obtiennent la même carte.
 */
export async function renderSettledCardText(db: Db, facts: SettledRequestFacts): Promise<string> {
  let standing: { agentName: string | null; brakeEngaged: boolean } | null = null;
  if (facts.status === 'approved' && facts.kind !== 'question' && facts.entityId && facts.agentId) {
    const rule = await getApprovalRule(db, {
      entityId: facts.entityId,
      agentId: facts.agentId,
      toolName: facts.toolName,
    });
    if (rule === 'auto_approve') {
      const [agent] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, facts.agentId))
        .limit(1);
      // Ici, et ici seulement, une lecture du frein qui échoue est rattrapée :
      // ce site ne décide rien, il rédige une note. Le frein qui compte est
      // appliqué ailleurs (étape 8b du loop, run-job côté runtime CLI).
      let paused = false;
      try {
        paused = await isAutoRunPaused(db, facts.entityId);
      } catch (err) {
        console.warn(
          '[approval-card] brake state unreadable, card note omitted:',
          err instanceof Error ? err.message : err,
        );
      }
      standing = {
        agentName: agent?.name ?? null,
        brakeEngaged: paused && isCodeExecutionTool(facts.toolName),
      };
    }
  }
  return settledApprovalCardText({ ...facts, standing });
}

/** Le texte de la carte d'UNE demande, relu en base. null : demande introuvable ou encore pending. */
export async function renderSettledCardTextFor(
  db: Db,
  approvalRequestId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      status: approvalRequests.status,
      kind: approvalRequests.kind,
      toolName: approvalRequests.toolName,
      answer: approvalRequests.answer,
      entityId: approvalRequests.entityId,
      agentId: approvalRequests.agentId,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId))
    .limit(1);
  if (!row || row.status === null || row.status === 'pending') return null;
  return renderSettledCardText(db, { ...row, status: row.status });
}

async function failOne(
  db: Db,
  card: SettledApprovalCard,
  error: string,
): Promise<CardSettlementOutcome> {
  const base = {
    cardId: card.id,
    approvalRequestId: card.approvalRequestId,
    channel: card.channel,
  };
  if (card.attempts >= APPROVAL_CARD_MAX_ATTEMPTS) {
    const detail =
      `gave up updating the ${card.channel} card for approval ${card.approvalRequestId} ` +
      `(message ${card.messageId}) after ${card.attempts} failed attempts; it still reads as ` +
      `pending there, although the request is ${card.status}. Last error: ${error}`;
    console.error(`[approval-card] ${detail}`);
    await finishApprovalCard(db, card.id, 'gave_up', error);
    return { ...base, outcome: 'gave_up', detail, attempts: card.attempts };
  }
  const detail =
    `could not update the ${card.channel} card for approval ${card.approvalRequestId} ` +
    `(message ${card.messageId}), attempt ${card.attempts}/${APPROVAL_CARD_MAX_ATTEMPTS}, ` +
    `retried on the next tick: ${error}`;
  console.warn(`[approval-card] ${detail}`);
  await releaseApprovalCardAfterFailure(db, card.id, error);
  return { ...base, outcome: 'will_retry', detail, attempts: card.attempts };
}

async function settleOne(db: Db, card: SettledApprovalCard): Promise<CardSettlementOutcome> {
  const base = {
    cardId: card.id,
    approvalRequestId: card.approvalRequestId,
    channel: card.channel,
  };
  const adapter = getAdapter(card.channel as ChannelKind);
  if (!adapter.capabilities.editMessage || !adapter.editMessageText) {
    // Un canal qui ne sait pas réécrire un message envoyé (WhatsApp) : la carte
    // y reste telle qu'envoyée. C'est définitif, et ce n'est pas tu (invariant #4).
    const detail =
      `${card.channel} cannot edit a sent message: the card for approval ` +
      `${card.approvalRequestId} (message ${card.messageId}) still reads as pending there, ` +
      `although the request is ${card.status}.`;
    console.warn(`[approval-card] ${detail}`);
    await finishApprovalCard(db, card.id, 'cannot_edit', detail);
    return { ...base, outcome: 'cannot_edit', detail };
  }
  let text: string;
  let creds: Record<string, string> | null;
  try {
    text = await renderSettledCardText(db, {
      status: card.status,
      kind: card.kind,
      toolName: card.toolName,
      answer: card.answer,
      entityId: card.requestEntityId,
      agentId: card.requestAgentId,
    });
    creds = await getBindingCredentials(db, card.agentId, card.channel);
  } catch (err) {
    return failOne(db, card, err instanceof Error ? err.message : String(err));
  }
  if (!creds) {
    return failOne(db, card, `no usable ${card.channel} credentials for agent ${card.agentId}`);
  }
  const edit = await adapter.editMessageText(creds, card.conversationId, card.messageId, text);
  if (!edit.ok) return failOne(db, card, edit.error);
  await finishApprovalCard(db, card.id, 'edited');
  return { ...base, outcome: 'edited', text };
}

/**
 * Met à jour les cartes des demandes tranchées : texte final, boutons retirés,
 * sur chaque canal qui sait réécrire un message ; un log explicite pour les
 * autres. `approvalRequestIds` borne à ces demandes ; absent, toutes.
 *
 * Une erreur de lecture/prise LÈVE (le tick la rapporte par guardPhase) ; une
 * édition ratée ne lève pas : elle est comptée, dite, et reprise.
 */
export async function settleApprovalCards(
  db: Db,
  opts: { approvalRequestIds?: readonly string[] } = {},
): Promise<CardSettlementOutcome[]> {
  const cards = await claimSettledApprovalCards(db, opts);
  const outcomes: CardSettlementOutcome[] = [];
  for (const card of cards) outcomes.push(await settleOne(db, card));
  return outcomes;
}

/** Le décompte d'un passage, pour le tick : seules les cartes RÉÉCRITES comptent comme mises à jour. */
export function countCardSettlement(outcomes: readonly CardSettlementOutcome[]): {
  edited: number;
  failed: number;
  cannotEdit: number;
} {
  return {
    edited: outcomes.filter((o) => o.outcome === 'edited').length,
    failed: outcomes.filter((o) => o.outcome === 'will_retry' || o.outcome === 'gave_up').length,
    cannotEdit: outcomes.filter((o) => o.outcome === 'cannot_edit').length,
  };
}
