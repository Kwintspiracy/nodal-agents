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
  adoptApprovalCard,
  claimApprovalCardForDisplay,
  releaseApprovalCardClaim,
  requeueApprovalCards,
  getBindingCredentials,
  eq,
  approvalRequests,
  agents,
} from '@nodal-agents/db';
import type { SettledApprovalCard, ApprovalCardLocation } from '@nodal-agents/db';
import { getAdapter, type CardButton, type ChannelKind } from '@nodal-agents/delivery';
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

/** Ce que `showApprovalCard` a fait. */
export type CardDisplayOutcome =
  /** La vue demandée est affichée (la demande est encore ouverte). */
  | { outcome: 'shown' }
  /** La demande était tranchée : la carte est passée par le règlement, pas par la vue demandée. */
  | { outcome: 'settled' }
  /** La carte est finie ou tenue par un autre écrivain : rien n'a été écrit. */
  | { outcome: 'busy' }
  /** L'édition a échoué ; la carte garde ce qu'elle montrait. */
  | { outcome: 'failed'; error: string };

/**
 * LA fonction qui affiche une carte encore ouverte — la question « Always
 * allow? », le retour « Back », tout ce qu'un clic veut y montrer. Avec
 * `settleApprovalCards`, c'est le seul écrivain d'une carte (#637), et les
 * deux partagent le même bail `claimed_at` :
 *
 * 1. la carte est adoptée (une carte jamais consignée entre dans le protocole),
 *    puis prise sous le bail — pas prise, rien n'est écrit ;
 * 2. le statut de la demande est RELU sous le bail : tranchée, la carte passe
 *    par le règlement (texte final, sans boutons), quoi qu'on ait demandé ;
 * 3. sinon la vue est écrite, son issue prise en compte, le bail rendu ;
 * 4. puis le règlement est rejoué : une décision arrivée PENDANT que la carte
 *    était tenue n'a pas pu la prendre — c'est ici qu'elle la rattrape, et non
 *    au tick suivant. Sans effet si la demande est encore ouverte.
 */
/** What a card shows: its text and its buttons. */
export interface CardView {
  text: string;
  buttons?: readonly (readonly CardButton[])[];
}

/**
 * A card rendered from its request AS IT STANDS, with the version of what it
 * shows. Rendered under the lease, then again before the lease is released:
 * a change written meanwhile (another gesture on the same form) is shown at
 * once, so the last edit always shows the row (review of #664, pass 4).
 * null: the request can no longer be rendered.
 */
export type LiveCardView = () => Promise<{ view: CardView; version: string } | null>;

/** Edits of one hold, at most: each one shows a change written during the previous one. */
const LIVE_CARD_EDITS = 3;

export async function showApprovalCard(
  db: Db,
  card: ApprovalCardLocation,
  view: CardView | LiveCardView,
): Promise<CardDisplayOutcome> {
  const cardId = await adoptApprovalCard(db, card);
  if (!(await claimApprovalCardForDisplay(db, cardId))) return { outcome: 'busy' };

  let result: CardDisplayOutcome;
  try {
    const [request] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, card.approvalRequestId))
      .limit(1);
    if (request?.status !== 'pending') {
      result = { outcome: 'settled' };
    } else {
      const adapter = getAdapter(card.channel as ChannelKind);
      const creds = await getBindingCredentials(db, card.agentId, card.channel);
      if (!adapter.editMessageText) {
        result = { outcome: 'failed', error: `${card.channel} cannot edit a sent message` };
      } else if (!creds) {
        result = {
          outcome: 'failed',
          error: `no usable ${card.channel} credentials for agent ${card.agentId}`,
        };
      } else {
        const editMessageText = adapter.editMessageText;
        const edit = async (v: CardView): Promise<CardDisplayOutcome> => {
          const r = await editMessageText(
            creds,
            card.conversationId,
            card.messageId,
            v.text,
            v.buttons,
          );
          return r.ok ? { outcome: 'shown' } : { outcome: 'failed', error: r.error };
        };
        if (typeof view !== 'function') {
          result = await edit(view);
        } else {
          result = { outcome: 'failed', error: 'the card could not be rendered from its request' };
          let shownVersion: string | null = null;
          for (let i = 0; i <= LIVE_CARD_EDITS; i += 1) {
            const live = await view();
            if (!live) break;
            if (live.version === shownVersion) break;
            if (i === LIVE_CARD_EDITS) {
              // Still changing after every edit allowed: what is shown is not
              // the row, and that is said; the next gesture redraws it.
              result = {
                outcome: 'failed',
                error: `the form kept changing during ${LIVE_CARD_EDITS} edits`,
              };
              break;
            }
            result = await edit(live.view);
            if (result.outcome !== 'shown') break;
            shownVersion = live.version;
          }
        }
      }
    }
  } finally {
    await releaseApprovalCardClaim(db, cardId);
  }
  if (result.outcome === 'failed') {
    console.warn(
      `[approval-card] could not show the ${card.channel} card of approval ` +
        `${card.approvalRequestId} (message ${card.messageId}): ${result.error}`,
    );
  }
  // Même traitement que dans resolveApprovalDecision : ce rattrapage ne décide
  // rien, et la carte non finie reste dans la file — le tick la reprend. Une
  // base indisponible ici ne doit pas faire tomber le traitement du clic.
  try {
    await settleApprovalCards(db, { approvalRequestIds: [card.approvalRequestId] });
  } catch (err) {
    console.error(
      `[approval-card] could not replay the settlement of approval ${card.approvalRequestId} ` +
        `after showing its card; the next cron tick retries: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return result;
}

/**
 * Un clic est arrivé sur la carte d'une demande DÉJÀ tranchée : la carte montre
 * donc encore des boutons (abandonnée après échecs, jamais consignée, ou
 * réécrite sans que ça tienne). Elle retourne dans la file de règlement, essais
 * remis à zéro, et le règlement est tenté tout de suite ; un échec est repris
 * au tick, comme n'importe quelle carte.
 *
 * `messageId` connu (Telegram) : la carte est adoptée si elle manque. Inconnu
 * (Discord, Slack : l'interaction ne le porte pas jusqu'ici) : les cartes
 * consignées de la demande sur ce canal et dans cette conversation.
 */
export async function requeueApprovalCard(
  db: Db,
  card: Omit<ApprovalCardLocation, 'messageId'> & { messageId?: string },
): Promise<CardSettlementOutcome[]> {
  if (card.messageId !== undefined)
    await adoptApprovalCard(db, { ...card, messageId: card.messageId });
  await requeueApprovalCards(db, {
    approvalRequestId: card.approvalRequestId,
    channel: card.channel,
    conversationId: card.conversationId,
  });
  return settleApprovalCards(db, { approvalRequestIds: [card.approvalRequestId] });
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
