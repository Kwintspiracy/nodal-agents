// telegram/approval-callback.ts — resolve an approval from an inline-button tap.
//
// The poller subscribes to `callback_query` updates (button taps). When a tap
// carries our `apr:<approvalId>:<a|r>` payload, we:
//   1. parse + validate the payload,
//   2. SECURITY-GATE: the tap must come from the SAME chat the approval card was
//      sent to (the job's chat_id) AND target an approval owned by THIS agent —
//      so a button can only be actioned from the authorized conversation,
//   3. resolve via the shared channel-neutral core (approvals/resolve.ts),
//   4. ack the tap and rewrite the card to a resolved state (buttons stripped).
//
// Best-effort throughout: a failure to ack/edit must never mask the fact that
// the decision was (or wasn't) persisted.

import { eq } from '@nodal-agents/db';
import { approvalRequests, agents } from '@nodal-agents/db';
import { answerTelegramCallback, type TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveApprovalDecision } from '../approvals/resolve.ts';
import {
  APPROVAL_CALLBACK_PREFIX,
  APPROVAL_BUTTON_LABELS,
  buildApprovalCardBody,
  resolveApprovalDeliveryTarget,
} from '../approvals/notify.ts';
import { showApprovalCard, requeueApprovalCard } from '../approvals/card-settlement.ts';
import { upsertAutoApproveRule, getApprovalRule, restoreApprovalRule } from '../approvals/rules.ts';
import { readQuestionToolInput } from '@nodal-agents/shared';

export interface HandleApprovalCallbackArgs {
  update: TelegramUpdate;
  /** The polling agent — the approval must belong to it (defense in depth). */
  receivingAgentId: string;
  botToken: string;
  deps: RunnerDeps;
  env: RunnerEnv;
}

export type ApprovalCallbackResult =
  | { handled: true; decision: 'approve' | 'reject'; jobId: string }
  // Le flux « Toujours autoriser » a deux étapes intermédiaires qui n'ont
  // rien résolu : la question de confirmation affichée, et la carte
  // restaurée après un « Back ». Elles sont TRAITÉES (le tap a eu un effet
  // visible) sans porter de décision.
  | { handled: true; decision: 'always_confirm_shown' | 'card_restored'; jobId: string }
  /** P10a — une option a été choisie sur une question ; le job reprend avec elle. */
  | { handled: true; decision: 'answer'; jobId: string; answer: string }
  | { handled: false; reason: string };

export type ApprovalCallbackDecision =
  | 'approve'
  | 'reject'
  /** P10a — une option d'une QUESTION a été choisie ; son rang est `optionIndex`. */
  | 'option'
  /** 1er tap sur 🔁 — afficher la question de confirmation. */
  | 'always_ask'
  /** Confirmation — écrire la règle auto_approve PUIS approuver. */
  | 'always_confirm'
  /** Annulation — restaurer la carte d'origine. */
  | 'always_back';

// `Object.create(null)` : un objet littéral hérite d'Object.prototype, donc
// DECISION_BY_SUFFIX['constructor'] renvoyait une valeur truthy et le garde
// `!decision` laissait passer des suffixes fantômes (revue P0 du 25/08).
// Sans prototype, seules les cinq clés réelles répondent.
const DECISION_BY_SUFFIX: Record<string, ApprovalCallbackDecision> = Object.assign(
  Object.create(null) as Record<string, ApprovalCallbackDecision>,
  {
    a: 'approve',
    r: 'reject',
    w: 'always_ask',
    wc: 'always_confirm',
    wb: 'always_back',
  } satisfies Record<string, ApprovalCallbackDecision>,
);

/** P10a — le suffixe d'une option : `o` suivi d'un entier décimal. */
const OPTION_SUFFIX = /^o(\d{1,3})$/;

/**
 * Ce qu'un payload de bouton PORTE une fois lu. Union discriminée : seul un
 * `option` a un index, et les handlers des trois canaux la reçoivent telle
 * quelle — un handler qui reconstruirait sa propre forme perdrait l'index.
 */
export type ParsedApprovalCallback =
  | { approvalRequestId: string; decision: Exclude<ApprovalCallbackDecision, 'option'> }
  | { approvalRequestId: string; decision: 'option'; optionIndex: number };

/**
 * Parse `apr:<uuid>:<a|r|w|wc|wb|o<n>>` → { id, decision }, or null if it isn't
 * ours / malformed.
 *
 * `o<n>` (P10a) carries the chosen option's INDEX and is NOT bounded here: this
 * function knows nothing about how many options the question had. Bounding it
 * would mean hardcoding `ask_user`'s maximum in a wire parser, and it would be
 * the wrong place anyway — the row is what says which options exist, and the
 * handler checks the index against it. A three-digit cap is kept only so a
 * forged payload cannot make us parse an arbitrarily long digit string.
 */
export function parseApprovalCallbackData(data: string | undefined): ParsedApprovalCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== APPROVAL_CALLBACK_PREFIX) return null;
  const [, id, d] = parts;
  if (!id || !d) return null;
  const option = OPTION_SUFFIX.exec(d);
  if (option?.[1] !== undefined) {
    return { approvalRequestId: id, decision: 'option', optionIndex: Number(option[1]) };
  }
  const decision = DECISION_BY_SUFFIX[d];
  if (!decision || decision === 'option') return null;
  return { approvalRequestId: id, decision };
}

export async function handleApprovalCallback(
  args: HandleApprovalCallbackArgs,
): Promise<ApprovalCallbackResult> {
  const { update, receivingAgentId, botToken, deps, env } = args;
  const cb = update.callback_query;
  if (!cb) return { handled: false, reason: 'no_callback_query' };

  const parsed = parseApprovalCallbackData(cb.data);
  if (!parsed) {
    // Not an approval button (or malformed) — ack so the client stops spinning.
    await answerTelegramCallback(botToken, cb.id);
    return { handled: false, reason: 'not_an_approval_callback' };
  }

  // SECURITY (decision 2026-07-04): approvals are DM-only. A group/supergroup
  // chat has multiple members who can tap the same inline button — the prior
  // chat-id check below only verified the TAP CAME FROM the right chat, not
  // that the right PERSON tapped it. Rather than try to identify "the right
  // person" in a group, refuse group approvals outright: reject anything that
  // isn't the bot's private chat with the requester, and do NOT resolve.
  const chatType = cb.message?.chat?.type;
  if (chatType !== 'private') {
    await answerTelegramCallback(
      botToken,
      cb.id,
      'Approvals can only be given in a private chat with the bot.',
      true,
    );
    return { handled: false, reason: 'not_private_chat' };
  }

  const tappedChatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;

  // Load the approval + its job to enforce the security boundary BEFORE resolving.
  const [approval] = await deps.db
    .select({
      id: approvalRequests.id,
      jobId: approvalRequests.jobId,
      agentId: approvalRequests.agentId,
      entityId: approvalRequests.entityId,
      status: approvalRequests.status,
      kind: approvalRequests.kind,
      toolName: approvalRequests.toolName,
      toolInput: approvalRequests.toolInput,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, parsed.approvalRequestId))
    .limit(1);

  if (!approval) {
    await answerTelegramCallback(botToken, cb.id, 'This request no longer exists.', true);
    return { handled: false, reason: 'approval_not_found' };
  }

  // Resolve who SHOULD deliver/own this approval's chat. On a delegated chain the
  // approval's agent (e.g. director) has no bot — the card was sent via the
  // orchestrator's bot, not the worker's. SECURITY: the card (and therefore the
  // only chat a tap can be authorized from) always lives in the bot OWNER's
  // private chat, never the chat that triggered the gated job — a `member`
  // (authorized non-owner, H-1) must not be able to self-approve its own
  // action by tapping from its own chat. See resolveApprovalDeliveryTarget.
  const target = await resolveApprovalDeliveryTarget(deps.db, approval.jobId);
  if (!target) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'no_delivery_target' };
  }

  // Defense in depth: the tap must arrive on the bot that delivered the card
  // (the orchestrator that owns the chat), not some other agent's bot.
  if (target.agentId !== receivingAgentId) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'agent_mismatch' };
  }

  // SECURITY: the tap must come from the same chat the card was delivered to.
  const jobChatId = target.chatId;

  if (tappedChatId === undefined || String(tappedChatId) !== jobChatId) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'chat_mismatch' };
  }

  /**
   * CETTE carte, telle que le protocole des cartes la connaît (#637). Le
   * handler n'écrit jamais la carte lui-même : il passe par `showApprovalCard`
   * (vue d'une demande ouverte) ou la remet au règlement.
   */
  const thisCard =
    messageId === undefined
      ? null
      : {
          approvalRequestId: approval.id,
          channel: 'telegram',
          agentId: target.agentId,
          conversationId: jobChatId,
          messageId: String(messageId),
        };

  // Already resolved (e.g. the dashboard won the race) — tell the user. The
  // card still had buttons, so whatever happened to it (edits that gave up, a
  // card never recorded, an edit that did not hold), it goes back to the
  // settlement queue, attempts reset, and is settled now (#637).
  if (approval.status !== 'pending') {
    await answerTelegramCallback(botToken, cb.id, `Already ${approval.status}.`);
    if (thisCard) await requeueApprovalCard(deps.db, thisCard);
    return { handled: false, reason: 'already_resolved' };
  }

  // ── 0145 — la question d'un SERVEUR MCP (élicitation) ─────────────────────
  // Elle se répond par un FORMULAIRE, que cette carte ne porte pas : ni ✅
  // (envoyer sans contenu), ni « Toujours » (une règle sur l'outil MCP qui l'a
  // posée), ni une option n'y ont de sens. Refusé, la demande reste ouverte et
  // se répond sur le dashboard.
  if (approval.kind === 'elicitation') {
    await answerTelegramCallback(botToken, cb.id, 'Answer this one from the dashboard.', true);
    return { handled: false, reason: 'elicitation_answered_on_dashboard' };
  }

  // ── P10a — répondre à une QUESTION ────────────────────────────────────────
  //
  // Placé APRÈS toutes les gardes de sécurité (chat privé, propriétaire, même
  // bot, même chat, encore pending) : répondre reprend un job, exactement comme
  // approuver, donc rien ici ne doit s'exécuter avant elles.
  //
  // Les deux sens du croisement sont refusés, jamais silencieusement traduits :
  // un ✅ sur une question ne dit pas LAQUELLE, et une option sur une
  // approbation n'a pas de liste où pointer. Le refus est explicite (invariant
  // #4) et la carte reste telle quelle, donc retentable.
  const isQuestion = approval.kind === 'question';

  if (parsed.decision === 'option') {
    if (!isQuestion) {
      await answerTelegramCallback(botToken, cb.id, 'Not a question.', true);
      return { handled: false, reason: 'not_a_question' };
    }
    const question = readQuestionToolInput(approval.toolInput);
    const chosen = question?.options[parsed.optionIndex];
    if (chosen === undefined) {
      await answerTelegramCallback(botToken, cb.id, 'Unknown option.', true);
      return { handled: false, reason: 'unknown_option' };
    }
    const answered = await resolveApprovalDecision(deps, env, {
      approvalRequestId: parsed.approvalRequestId,
      decision: 'approve',
      answer: chosen,
      resolvedBy: 'telegram',
    });
    if (!answered.ok) {
      await answerTelegramCallback(botToken, cb.id, 'Could not apply — try the dashboard.', true);
      return { handled: false, reason: answered.code };
    }
    // La carte (réponse, boutons retirés) est réécrite par
    // resolveApprovalDecision → settleApprovalCards : un seul écrivain (#637).
    await answerTelegramCallback(botToken, cb.id, `✅ ${chosen}`);
    return { handled: true, decision: 'answer', jobId: answered.jobId, answer: chosen };
  }

  if (isQuestion && parsed.decision !== 'reject') {
    // `a`, `w`, `wc`, `wb` sur une question : approuver sans choisir n'a pas de
    // sens, et une règle « toujours » sur une question voudrait dire « réponds
    // toujours la même chose », ce qui n'est pas une chose que l'on accorde.
    // Décliner (`r`) reste possible et passe plus bas, inchangé.
    await answerTelegramCallback(botToken, cb.id, 'Pick an option.', true);
    return { handled: false, reason: 'question_needs_option' };
  }

  // ── Flux « Toujours autoriser » (lot approbations, 24/08) ────────────────
  // Un grant permanent mérite un second geste délibéré (même règle que le
  // ConfirmDialog du web) : le 1er tap ÉDITE la carte en question de
  // confirmation, rien n'est résolu ; « Back » restaure la carte d'origine à
  // l'identique ; la confirmation écrit la règle AVANT d'approuver — l'ordre
  // inverse laisserait croire à un grant permanent qui n'existe pas si
  // l'écriture de la règle échouait.

  // Le nom de l'agent CONCERNÉ — sur une chaîne déléguée c'est le worker, pas
  // l'orchestrateur qui possède le bot. La question de confirmation et la
  // carte finale le nomment : accorder un droit permanent à « cet agent »
  // sans dire lequel est un piège (revue P0 du 25/08).
  let agentNameForCard: string | null = null;
  if (approval.agentId) {
    const [row] = await deps.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, approval.agentId))
      .limit(1);
    agentNameForCard = row?.name ?? null;
  }

  if (parsed.decision === 'always_ask') {
    // Par `showApprovalCard` (#637) : sous le bail des cartes, statut relu au
    // moment d'écrire — une demande tranchée entre la lecture `pending` plus
    // haut et cette édition reçoit son texte final, jamais des boutons actifs.
    if (thisCard) {
      await showApprovalCard(deps.db, thisCard, {
        text:
          `⚠️ Always allow ${approval.toolName} for ${agentNameForCard ?? 'this agent'}?\n\n` +
          `It will run without asking, whatever its arguments. ` +
          `Revocable anytime from the agent's Autonomy tab.`,
        buttons: [
          [
            {
              label: '✅ Yes, always',
              callbackData: `${APPROVAL_CALLBACK_PREFIX}:${approval.id}:wc`,
            },
            { label: '↩ Back', callbackData: `${APPROVAL_CALLBACK_PREFIX}:${approval.id}:wb` },
          ],
        ],
      });
    }
    await answerTelegramCallback(botToken, cb.id, 'One more tap to confirm.');
    return { handled: true, decision: 'always_confirm_shown', jobId: approval.jobId };
  }

  if (parsed.decision === 'always_back') {
    // entityId nullable au schema (legacy) : sans lui, impossible de
    // reconstruire l'explication (contexte MCP) — on retire la question, mais
    // une carte ouverte garde ses boutons tant que la demande est pending
    // (#637) : approuver ou refuser ne demande pas d'entité. « Always allow »
    // seul en demande une (la règle s'y lie, always_confirm la refuse sans) :
    // il n'est pas reproposé.
    if (!approval.entityId) {
      if (thisCard) {
        const cbId = `${APPROVAL_CALLBACK_PREFIX}:${approval.id}`;
        await showApprovalCard(deps.db, thisCard, {
          text: `⏳ Still pending — ${approval.toolName}. Tap a button below to decide — or resolve it from the dashboard.`,
          buttons: [
            [
              { label: APPROVAL_BUTTON_LABELS.approve, callbackData: `${cbId}:a` },
              { label: APPROVAL_BUTTON_LABELS.reject, callbackData: `${cbId}:r` },
            ],
          ],
        });
      }
      await answerTelegramCallback(botToken, cb.id);
      return { handled: true, decision: 'card_restored', jobId: approval.jobId };
    }
    if (thisCard) {
      const [agentRow] = approval.agentId
        ? await deps.db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, approval.agentId))
            .limit(1)
        : [];
      const body = await buildApprovalCardBody(deps.db, {
        entityId: approval.entityId,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
        who: agentRow?.name ?? 'An agent',
      });
      const cbId = `${APPROVAL_CALLBACK_PREFIX}:${approval.id}`;
      // Par `showApprovalCard`, comme la question de confirmation (#637).
      await showApprovalCard(deps.db, thisCard, {
        text: `${body}\n\nTap a button below to decide — or resolve it from the dashboard.`,
        buttons: [
          [
            { label: APPROVAL_BUTTON_LABELS.approve, callbackData: `${cbId}:a` },
            { label: APPROVAL_BUTTON_LABELS.reject, callbackData: `${cbId}:r` },
          ],
          [{ label: APPROVAL_BUTTON_LABELS.always, callbackData: `${cbId}:w` }],
        ],
      });
    }
    await answerTelegramCallback(botToken, cb.id);
    return { handled: true, decision: 'card_restored', jobId: approval.jobId };
  }

  if (parsed.decision === 'always_confirm') {
    // Une règle est TOUJOURS agent-scopée ici — une approbation sans agent
    // (théorique) n'a pas de cible : refus honnête plutôt qu'une règle
    // entity-wide que personne n'a demandée.
    if (!approval.agentId || !approval.entityId) {
      await answerTelegramCallback(botToken, cb.id, 'No agent to bind — use the dashboard.', true);
      return { handled: false, reason: 'no_agent_for_rule' };
    }
    // Règle D'ABORD : si elle échoue, l'approbation reste pending — visible et
    // retentable — au lieu d'un appel approuvé sous un grant fantôme. L'état
    // PRÉCÉDENT est capturé pour pouvoir revenir en arrière si la résolution
    // échoue ensuite (revue P0 du 25/08 : sans ce rollback, un tap sur une
    // carte périmée laissait une règle permanente en base alors que le
    // message disait « rien n'a bougé »).
    const previousRule = await getApprovalRule(deps.db, {
      entityId: approval.entityId,
      agentId: approval.agentId,
      toolName: approval.toolName,
    });
    try {
      await upsertAutoApproveRule(deps.db, {
        entityId: approval.entityId,
        agentId: approval.agentId,
        toolName: approval.toolName,
      });
    } catch (err) {
      console.error('[approval-callback] auto_approve rule write failed:', err);
      await answerTelegramCallback(
        botToken,
        cb.id,
        'Could not save the standing rule — nothing changed. Try the dashboard.',
        true,
      );
      return { handled: false, reason: 'rule_write_failed' };
    }

    // La règle est déjà COMMITÉE : à partir d'ici, toute sortie qui n'aboutit
    // pas doit la retirer — y compris une sortie par EXCEPTION.
    //
    // Sans ce try, un blip de base au milieu de la résolution laissait la
    // règle posée et faisait remonter l'erreur jusqu'au poller, qui rejoue le
    // même clic sans avancer son offset. La seconde tentative relisait alors
    // l'état laissé par la première : `previousRule` valait `auto_approve`, et
    // un échec propre au rejeu « restaurait » ce blanc-seing au lieu de le
    // supprimer. Résultat : un droit permanent SILENCIEUX qu'aucun geste
    // n'avait validé, sous un message disant « rien n'a bougé ».
    //
    // On répare donc AVANT que le poller ne rejoue, puis on relance l'erreur :
    // la seconde tentative repart d'un état propre.
    let confirmed: Awaited<ReturnType<typeof resolveApprovalDecision>>;
    try {
      confirmed = await resolveApprovalDecision(deps, env, {
        approvalRequestId: parsed.approvalRequestId,
        decision: 'approve',
        resolvedBy: 'telegram',
        notes: 'Always allowed from the Telegram card.',
      });
    } catch (err) {
      await restoreApprovalRule(deps.db, {
        entityId: approval.entityId,
        agentId: approval.agentId,
        toolName: approval.toolName,
        previousAction: previousRule,
      });
      throw err;
    }
    if (!confirmed.ok) {
      // La résolution a échoué (job annulé, approbation expirée, déjà
      // résolue…) : le grant permanent n'a plus de raison d'être — on remet
      // l'état d'avant, sinon le message ci-dessous mentirait.
      await restoreApprovalRule(deps.db, {
        entityId: approval.entityId,
        agentId: approval.agentId,
        toolName: approval.toolName,
        previousAction: previousRule,
      });
      await answerTelegramCallback(botToken, cb.id, 'Could not apply — try the dashboard.', true);
      return { handled: false, reason: confirmed.code };
    }

    // La carte (« will now run without asking », avec la réserve du frein
    // quand elle s'applique) est réécrite par resolveApprovalDecision →
    // settleApprovalCards, qui lit la règle posée ci-dessus : un seul écrivain,
    // un seul texte, le même que pour un « Toujours » donné depuis le web (#637).
    await answerTelegramCallback(botToken, cb.id, '✅ Always allowed');
    return { handled: true, decision: 'approve', jobId: confirmed.jobId };
  }

  const result = await resolveApprovalDecision(deps, env, {
    approvalRequestId: parsed.approvalRequestId,
    decision: parsed.decision,
    resolvedBy: 'telegram',
  });

  if (!result.ok) {
    // Lost a race between the pending check and the resolve, or job vanished.
    await answerTelegramCallback(botToken, cb.id, 'Could not apply — try the dashboard.', true);
    return { handled: false, reason: result.code };
  }

  // La carte est réécrite par resolveApprovalDecision → settleApprovalCards (#637).
  await answerTelegramCallback(
    botToken,
    cb.id,
    parsed.decision === 'approve' ? '✅ Approved' : '❌ Rejected',
  );

  return { handled: true, decision: parsed.decision, jobId: result.jobId };
}
