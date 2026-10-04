// approvals/elicitation-channel.ts — remplir, DEPUIS LE CANAL, la question
// qu'un serveur MCP a posée pendant un appel (0145) : un geste sur la carte
// (`eli:<id>:<op>`), ou la valeur d'un champ tapée EN RÉPONSE à la carte.
//
// Neutre vis-à-vis du canal : Telegram, Discord et Slack n'y apportent que la
// forme de leur événement (qui, où, quel bouton, à quel message on répond) et
// la façon d'afficher l'avis rendu. Tout le reste vit ici, une fois :
//
//   - LA carte fait autorité. Un geste ou une réponse n'est reçu que s'il vient
//     de la conversation où la carte a été CONSIGNÉE (#637), par le bot qui l'a
//     envoyée — la conversation où la demande est née. Rien d'autre ne
//     désigne une élicitation.
//   - Le brouillon vit en base (`approval_requests.draft`, 0146). Un geste le
//     relit, applique UNE opération (valeur explicite, jamais une bascule), le
//     réécrit sous condition que la demande soit encore ouverte, puis réécrit
//     la carte par `showApprovalCard` — l'écrivain des cartes, sous son bail.
//   - Envoyer, c'est `resolveApprovalDecision` avec les valeurs du brouillon :
//     la même validation que le web et la même écriture. « Send » porte la
//     révision des valeurs que la carte MONTRAIT ; une carte périmée n'envoie
//     rien et est réécrite.
//   - Tout refus est DIT (invariant #4) : un bouton qui ne désigne plus rien,
//     une valeur hors bornes, un formulaire incomplet — avec la raison.

import {
  and,
  eq,
  approvalRequests,
  approvalCardMessages,
  getBindingCredentials,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import {
  applyElicitationOp,
  applyTypedElicitationValue,
  elicitationDraftRevision,
  describeElicitationErrors,
  elicitationActionLabels,
  parseElicitationCallbackData,
  type ElicitationDraft,
} from '@nodal-agents/shared';
import { getAdapter, type ChannelKind } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { draftIs, resolveApprovalDecision } from './resolve.ts';
import { showApprovalCard, requeueApprovalCard } from './card-settlement.ts';
import {
  loadElicitationCard,
  renderElicitationCardFor,
  type ElicitationCardState,
} from './elicitation-card-view.ts';

/** Ce qu'un geste ou une réponse a donné, pour le canal qui l'affiche. */
export type ElicitationInteractionResult =
  /** Reçu. `notice` : une phrase à montrer à la personne (null : la carte réécrite suffit). */
  | { handled: true; notice: string | null }
  /** Refusé ; `notice` dit pourquoi. */
  | { handled: false; reason: string; notice: string };

/** Où la personne a agi. */
export interface ElicitationOrigin {
  channel: ChannelKind;
  /** Le bot qui a reçu le geste — celui qui a envoyé la carte. */
  receivingAgentId: string;
  conversationId: string;
}

interface CardRow {
  approvalRequestId: string;
  channel: string;
  agentId: string;
  conversationId: string;
  messageId: string;
}

/** La carte consignée de cette demande dans cette conversation, par ce bot. */
async function findCard(
  db: AnyDrizzleDb,
  origin: ElicitationOrigin,
  where: { approvalRequestId?: string; messageId?: string },
): Promise<CardRow | null> {
  const [row] = await db
    .select({
      approvalRequestId: approvalCardMessages.approvalRequestId,
      channel: approvalCardMessages.channel,
      agentId: approvalCardMessages.agentId,
      conversationId: approvalCardMessages.conversationId,
      messageId: approvalCardMessages.messageId,
    })
    .from(approvalCardMessages)
    .where(
      and(
        eq(approvalCardMessages.channel, origin.channel),
        eq(approvalCardMessages.agentId, origin.receivingAgentId),
        eq(approvalCardMessages.conversationId, origin.conversationId),
        ...(where.approvalRequestId
          ? [eq(approvalCardMessages.approvalRequestId, where.approvalRequestId)]
          : []),
        ...(where.messageId ? [eq(approvalCardMessages.messageId, where.messageId)] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Une carte périmée : l'avis nomme le bouton d'accord que la carte porte. */
function staleNotice(state: ElicitationCardState): string {
  const accept = elicitationActionLabels(state.asked.actions).accept;
  return `The values changed since this card was drawn. Check them, then tap ${accept} again.`;
}

/** Ce qu'une demande tranchée est devenue, dit à qui touche encore sa carte. */
function closedNotice(status: string | null): string {
  if (status === 'approved') return 'Already answered.';
  if (status === 'rejected') return 'Already declined.';
  return 'This question is closed.';
}

/**
 * Écrit le brouillon SUR celui qui a été lu (`expected`, la colonne telle que
 * lue ; null : aucun), et seulement si la demande est encore ouverte.
 *
 * - `closed` : tranchée entre la lecture du geste et son écriture (sur le
 *   web, sur un autre canal, par l'expiration) ; un geste tardif ne réécrit
 *   jamais le formulaire d'une question close.
 * - `changed` : un autre geste a écrit entre-temps (Discord et Slack
 *   traitent deux taps en même temps) ; l'appelant relit et rejoue le sien,
 *   au lieu d'écraser celui-là.
 */
export async function saveElicitationDraft(
  db: AnyDrizzleDb,
  approvalRequestId: string,
  expected: unknown,
  draft: ElicitationDraft,
): Promise<'saved' | 'closed' | 'changed'> {
  const rows = await db
    .update(approvalRequests)
    .set({ draft })
    .where(
      and(
        eq(approvalRequests.id, approvalRequestId),
        eq(approvalRequests.status, 'pending'),
        draftIs(expected),
      ),
    )
    .returning({ id: approvalRequests.id });
  if (rows.length > 0) return 'saved';
  const [now] = await db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId))
    .limit(1);
  return now?.status === 'pending' ? 'changed' : 'closed';
}

/** Combien de fois un geste est rejoué sur un brouillon que d'autres gestes changent. */
const DRAFT_WRITE_ATTEMPTS = 3;

type DraftChange =
  | { ok: true; draft: ElicitationDraft }
  | { ok: false; reason: string; notice: string };

/**
 * Applique un geste au brouillon : relit la demande, calcule le brouillon
 * suivant, vérifie que sa carte tient dans le canal, et l'écrit sur celui qui
 * a été lu. Rejoué sur le nouveau brouillon quand un autre geste l'a changé
 * entre-temps — chaque geste pose une valeur EXPLICITE, le rejouer est sûr.
 */
async function changeDraft(
  db: AnyDrizzleDb,
  card: CardRow,
  first: ElicitationCardState,
  next: (state: ElicitationCardState) => DraftChange,
): Promise<
  | { ok: true; state: ElicitationCardState; draft: ElicitationDraft }
  | { ok: false; reason: string; notice: string }
> {
  let state = first;
  for (let attempt = 1; ; attempt += 1) {
    const change = next(state);
    if (!change.ok) return change;
    const view = renderElicitationCardFor(state, card.channel as ChannelKind, change.draft);
    if (!view.ok) {
      return {
        ok: false,
        reason: 'card_too_large',
        notice: `Not taken: ${view.reason}. Answer from the dashboard.`,
      };
    }
    const written = await saveElicitationDraft(
      db,
      state.approvalRequestId,
      state.storedDraft,
      change.draft,
    );
    if (written === 'saved') return { ok: true, state, draft: change.draft };
    if (written === 'closed' || attempt >= DRAFT_WRITE_ATTEMPTS) {
      await requeueApprovalCard(db, card);
      return written === 'closed'
        ? { ok: false, reason: 'already_resolved', notice: 'This question is closed.' }
        : {
            ok: false,
            reason: 'draft_busy',
            notice: 'The card is being changed from elsewhere. Try again.',
          };
    }
    const reloaded = await loadElicitationCard(db, state.approvalRequestId);
    if (!reloaded.ok) {
      return {
        ok: false,
        reason: reloaded.reason,
        notice: 'This question cannot be answered here.',
      };
    }
    state = reloaded.state;
  }
}

/**
 * Une réponse tapée est-elle la réponse à la carte d'une question de serveur
 * de cette conversation ? La même lecture que `handleElicitationReply`, sans
 * rien écrire : un canal qui reçoit un même message par deux chemins (Slack :
 * `message` et `app_mention`) ne le traite qu'une fois.
 */
export async function isElicitationCardReply(
  deps: RunnerDeps,
  origin: ElicitationOrigin,
  replyToMessageId: string,
): Promise<boolean> {
  const db = deps.db as AnyDrizzleDb;
  const card = await findCard(db, origin, { messageId: replyToMessageId });
  if (!card) return false;
  // An OPEN question only, as handleElicitationReply: a reply to a settled
  // card is an ordinary message.
  const loaded = await loadElicitationCard(db, card.approvalRequestId);
  return loaded.ok && loaded.state.status === 'pending';
}

/** Réécrit la carte avec ce brouillon, sous le bail des cartes (#637). */
async function redraw(
  db: AnyDrizzleDb,
  card: CardRow,
  state: ElicitationCardState,
  draft: ElicitationDraft,
): Promise<void> {
  const view = renderElicitationCardFor(state, card.channel as ChannelKind, draft);
  if (!view.ok) {
    // La carte envoyée tenait dans le canal ; seul un formulaire changé depuis
    // ne tiendrait plus. Dit, et la carte garde ce qu'elle montrait.
    console.warn(
      `[elicitation] card of ${state.approvalRequestId} cannot be redrawn on ${card.channel}: ${view.reason}`,
    );
    return;
  }
  await showApprovalCard(db, card, { text: view.text, buttons: view.buttons });
}

/**
 * Un geste sur la carte : `data` est le `callback_data` / `custom_id` /
 * `action_id` du bouton (`eli:<id>:<op>`).
 */
export async function handleElicitationTap(args: {
  deps: RunnerDeps;
  env: RunnerEnv;
  origin: ElicitationOrigin;
  data: string;
}): Promise<ElicitationInteractionResult> {
  const { deps, env, origin } = args;
  const db = deps.db as AnyDrizzleDb;
  const parsed = parseElicitationCallbackData(args.data);
  if (!parsed)
    return { handled: false, reason: 'malformed', notice: 'This button cannot be read.' };

  const card = await findCard(db, origin, { approvalRequestId: parsed.approvalRequestId });
  if (!card) return { handled: false, reason: 'not_authorized', notice: 'Not authorized.' };

  const loaded = await loadElicitationCard(db, parsed.approvalRequestId);
  if (!loaded.ok) {
    return {
      handled: false,
      reason: loaded.reason,
      notice: 'This question cannot be answered here.',
    };
  }
  const { state } = loaded;
  if (state.status !== 'pending') {
    // La carte montre encore des boutons : elle retourne au règlement (#637).
    await requeueApprovalCard(db, card);
    return { handled: false, reason: 'already_resolved', notice: closedNotice(state.status) };
  }

  const { op } = parsed;
  if (op.op === 'decline') {
    const r = await resolveApprovalDecision(deps, env, {
      approvalRequestId: state.approvalRequestId,
      decision: 'reject',
      resolvedBy: origin.channel,
    });
    return r.ok
      ? { handled: true, notice: 'Declined.' }
      : { handled: false, reason: r.code, notice: closedNotice(r.status ?? null) };
  }

  if (op.op === 'send') {
    if (op.revision !== elicitationDraftRevision(state.draft.values)) {
      await redraw(db, card, state, state.draft);
      return {
        handled: false,
        reason: 'stale_card',
        notice: staleNotice(state),
      };
    }
    const r = await resolveApprovalDecision(deps, env, {
      approvalRequestId: state.approvalRequestId,
      decision: 'approve',
      resolvedBy: origin.channel,
      content: state.draft.values,
      // Tranchée sur les valeurs que Send a lues : un geste qui les change
      // entre-temps fait refuser l'envoi, jamais envoyer les anciennes.
      expectedDraft: state.storedDraft,
    });
    if (r.ok) return { handled: true, notice: 'Answered.' };
    if (r.code === 'draft_changed') {
      const fresh = await loadElicitationCard(db, state.approvalRequestId);
      if (fresh.ok) await redraw(db, card, fresh.state, fresh.state.draft);
      return {
        handled: false,
        reason: 'stale_card',
        notice: staleNotice(state),
      };
    }
    if (r.code === 'content_invalid') {
      return {
        handled: false,
        reason: r.code,
        notice: `Not sent: ${describeElicitationErrors(r.errors ?? [])}.`,
      };
    }
    return { handled: false, reason: r.code, notice: closedNotice(r.status ?? null) };
  }

  const changed = await changeDraft(db, card, state, (s) => {
    const applied = applyElicitationOp(s.fields, s.draft, op);
    return applied.ok
      ? { ok: true, draft: applied.draft }
      : { ok: false, reason: 'stale_button', notice: `Not applied: ${applied.reason}.` };
  });
  if (!changed.ok) return { handled: false, reason: changed.reason, notice: changed.notice };
  await redraw(db, card, changed.state, changed.draft);
  if (op.op === 'type') {
    const field = state.fields[op.field]!;
    return { handled: true, notice: `Reply to the card with ${field.label}.` };
  }
  return { handled: true, notice: null };
}

/**
 * Un message tapé EN RÉPONSE à un message du bot. Reçu seulement quand ce
 * message est la carte d'une élicitation ouverte de cette conversation ; sinon
 * `handled: false, reason: 'not_a_card'` et le message suit son chemin
 * habituel (un tour de conversation).
 *
 * L'avis (valeur refusée, aucun champ en attente) est ENVOYÉ dans la
 * conversation : un message n'a pas de bulle de réponse comme un bouton.
 */
export async function handleElicitationReply(args: {
  deps: RunnerDeps;
  origin: ElicitationOrigin;
  replyToMessageId: string;
  text: string;
}): Promise<ElicitationInteractionResult> {
  const { deps, origin } = args;
  const db = deps.db as AnyDrizzleDb;
  const card = await findCard(db, origin, { messageId: args.replyToMessageId });
  if (!card) return { handled: false, reason: 'not_a_card', notice: '' };
  const loaded = await loadElicitationCard(db, card.approvalRequestId);
  if (!loaded.ok) {
    // Une réponse à la carte d'une approbation ou d'une question d'agent :
    // ce n'est pas un formulaire, le message suit son chemin habituel.
    return { handled: false, reason: 'not_a_card', notice: '' };
  }
  const { state } = loaded;

  const say = async (notice: string): Promise<void> => {
    const creds = await getBindingCredentials(db, card.agentId, card.channel);
    if (!creds) return;
    await getAdapter(card.channel as ChannelKind)
      .sendText(creds, card.conversationId, notice)
      .catch((err: unknown) => {
        console.warn(
          `[elicitation] could not tell ${card.channel} ${card.conversationId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
  };

  // A reply to a card already settled is not an answer: it follows its usual
  // path, a turn of the conversation (review of #664, pass 3).
  if (state.status !== 'pending') {
    return { handled: false, reason: 'already_resolved', notice: '' };
  }
  // The field this reply is for, read now: a replay after another gesture
  // moved the ✏️ is refused, never written into the other field.
  const forField = state.draft.awaiting;
  const changed = await changeDraft(db, card, state, (s) => {
    const typed = applyTypedElicitationValue(s.fields, s.draft, args.text, forField);
    if (typed.ok) return { ok: true, draft: typed.draft };
    return {
      ok: false,
      reason: 'value_refused',
      notice:
        s.draft.awaiting === null
          ? 'Tap ✏️ next to a field on the card first, then reply with its value.'
          : `Not taken: ${typed.reason}.`,
    };
  });
  if (!changed.ok) {
    await say(changed.notice);
    return { handled: true, notice: changed.notice };
  }
  await redraw(db, card, changed.state, changed.draft);
  return { handled: true, notice: null };
}
