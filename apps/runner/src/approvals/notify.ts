// approvals/notify.ts — deterministic, server-sent approval notification.
//
// WHY this exists: before this, the ONLY signal that a job was waiting for
// approval on Telegram was a *nudge* asking the LLM to call telegram_send_message
// (execute.ts). That nudge was gated on `!toolDelivered` and on the model
// actually complying — so in common cases (the agent had already sent any
// message, or simply ignored the nudge) the user got NOTHING and the job paused
// silently. This module makes the notification deterministic: the runner itself
// sends the message the instant the approval is created, regardless of the LLM.
//
// It also attaches ✅/❌ inline buttons so the user can resolve the approval from
// Telegram (handled by telegram/approval-callback.ts) — no dashboard required.
//
// Channel-neutral by construction: this is wired in via the tool layer's
// `onApprovalRequired` callback, which knows nothing about Telegram. A no-bot /
// no-chat job simply gets no card (the dashboard path is unaffected).

import { eq, and } from '@nodal-agents/db';
import {
  agents,
  agentJobs,
  telegramAllowedChats,
  getChannelBinding,
  getBindingCredentials,
  decryptChannelSecret,
  resolveOwnerConversation,
  recordApprovalCardMessage,
  approvalRequestAttachments,
} from '@nodal-agents/db';
import {
  redactSecretsForAudit,
  renderExplanationText,
  readQuestionToolInput,
  quoteThirdPartyText,
} from '@nodal-agents/shared';
import { explainApprovalRequest } from './explain-request.ts';
import {
  getAdapter,
  resolveTransportChannel,
  listActiveChannelsForAgent,
  isTransportChannel,
  jobChatOn,
  type ApprovalCard,
  type QuestionCard,
  type ChannelKind,
  type ChannelCredentials,
  type SendResult,
} from '@nodal-agents/delivery';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';
import { loadElicitationCard, renderElicitationCardFor } from './elicitation-card-view.ts';

/** callback_data carried by the buttons. Parsed by approval-callback.ts. Stays well under Telegram's 64-byte cap. */
export const APPROVAL_CALLBACK_PREFIX = 'apr';

/**
 * Libellés des boutons de carte — exportés pour que le flux « Toujours
 * autoriser » (telegram/approval-callback.ts) reconstruise la carte d'origine
 * à l'identique quand l'utilisateur annule la confirmation.
 */
export const APPROVAL_BUTTON_LABELS = {
  approve: '✅ Approve',
  reject: '❌ Reject',
  always: '🔁 Always allow',
} as const;

/**
 * Le corps de la carte d'approbation (trois étages : la voix de l'agent, la
 * ligne d'impact déterministe, le détail technique). Partagé entre l'envoi
 * initial et la restauration de la carte après un « annuler » du flux
 * Toujours autoriser — les deux doivent dire exactement la même chose.
 */
export async function buildApprovalCardBody(
  db: RunnerDeps['db'],
  args: {
    entityId: string;
    agentId: string | null;
    toolName: string;
    toolInput: unknown;
    who: string;
  },
): Promise<string> {
  const explanation = await explainApprovalRequest(
    db,
    args.entityId,
    args.agentId,
    args.toolName,
    args.toolInput,
  );
  return (
    `⏳ Approbation requise — ${args.who}\n\n` +
    // The agent's own words stay first and verbatim (invariant #2), but they
    // are clearly ITS voice, quoted — not the platform's verdict. An ABSENT
    // purpose is stated, never left blank (asserted by notify.test.ts).
    (explanation.purpose
      ? `« ${explanation.purpose} »\n\n`
      : "L'agent n'a pas expliqué pourquoi.\n\n") +
    renderExplanationText(explanation)
  );
}
/**
 * Le corps de la carte de QUESTION (P10a). Deux étages seulement : la voix de
 * l'agent — son nom, sa question VERBATIM, le contexte qu'il a jugé utile
 * (invariant #2 : le produit ne reformule pas ce qu'il demande) — puis une
 * ligne de plateforme qui dit où répondre.
 *
 * Pas d'étage « impact » comme sur une approbation : une question ne fait rien.
 * Ce qu'il faut savoir pour choisir est dans le contexte que l'agent a écrit.
 */
export function buildQuestionCardBody(args: {
  who: string;
  question: string;
  context: string | null;
  /** Vrai quand le canal rend des boutons — la dernière ligne en dépend. */
  hasButtons: boolean;
}): string {
  return (
    `❓ ${args.who} asks:\n\n` +
    `« ${args.question} »\n\n` +
    (args.context ? `${args.context}\n\n` : '') +
    (args.hasButtons
      ? 'Tap an option below, or answer from the dashboard.'
      : 'Answer from the dashboard: Approvals page.')
  );
}

/**
 * La carte d'une question qu'un SERVEUR MCP pose pendant un de ses appels
 * (élicitation, 0145), sur un canal. Le message est cité tel quel — texte
 * tiers, montré comme une donnée ; le cadre est celui du produit.
 *
 * Sans boutons sur aucun canal pour l'instant : un formulaire ne se remplit
 * pas d'un ✅, il se remplit sur le dashboard (la carte le dit).
 */
export function buildElicitationCardBody(args: { server: string; message: string }): string {
  return (
    `❓ The MCP server "${args.server}" asks:

` +
    `${quoteThirdPartyText(args.message)}

` +
    'Answer from the dashboard: the question is on the run, and on the Approvals page.'
  );
}

/**
 * Le texte d'une carte dont la demande est tranchée (#637) — UNE source pour
 * tous les chemins qui réécrivent une carte : le clic sur la carte elle-même
 * (Telegram, Discord, Slack) et le point qui met à jour les cartes quand la
 * demande est tranchée ailleurs (`approvals/card-settlement.ts`). Les deux
 * doivent dire la même chose de la même demande.
 */
export function settledApprovalCardText(args: {
  status: string;
  kind: string;
  toolName: string;
  answer: string | null;
  /**
   * Une règle `auto_approve` couvre désormais cet outil pour cet agent (le
   * « Toujours autoriser » de la carte ou du web) : la carte le dit, avec la
   * réserve du frein d'urgence quand elle s'applique. null : pas de règle.
   */
  standing?: { agentName: string | null; brakeEngaged: boolean } | null;
}): string {
  // 0145 — une élicitation n'approuve pas l'outil qui l'a posée : elle a été
  // répondue, refusée, ou fermée sans réponse. « Répondue », jamais
  // « envoyée » : la décision est écrite ici, le run la rend au serveur
  // ensuite, et un runner qui meurt entre les deux ne l'a pas rendue (revue
  // Codex passe 2 de #660). La carte dit ce qui est su.
  if (args.kind === 'elicitation') {
    if (args.status === 'approved') return '✅ Answered';
    if (args.status === 'rejected') return '❌ Declined';
    if (args.status === 'expired') return '⌛ Closed without an answer';
  }
  if (args.status === 'approved' && args.kind === 'question' && args.answer !== null) {
    return `✅ Answered: ${args.answer}`;
  }
  if (args.status === 'approved' && args.standing) {
    // Le frein d'urgence rend une règle auto_approve d'outil de code dormante :
    // promettre « ne demandera plus » serait faux (invariant #4).
    const brakeNote = args.standing.brakeEngaged
      ? ' The workspace auto-run brake is engaged, so it will keep asking until you release it in Settings.'
      : '';
    return (
      `✅ Approved — ${args.toolName} will now run without asking for ` +
      `${args.standing.agentName ?? 'this agent'}.${brakeNote}`
    );
  }
  if (args.status === 'approved') return `✅ Approved — ${args.toolName}`;
  if (args.status === 'rejected') return `❌ Rejected — ${args.toolName}`;
  if (args.status === 'expired') return `⌛ Expired — ${args.toolName}`;
  // Un statut que ce texte ne connaît pas : on le dit tel quel plutôt que de
  // laisser croire à un des trois ci-dessus.
  return `${args.toolName}: ${args.status}`;
}

export function approvalCallbackData(approvalRequestId: string, decision: 'a' | 'r'): string {
  return `${APPROVAL_CALLBACK_PREFIX}:${approvalRequestId}:${decision}`;
}

/** The bot + chat that can actually reach the user for a (possibly delegated) job. */
export interface TelegramDeliveryTarget {
  /** Agent that OWNS the bot (the orchestrator on delegated chains) — the callback authority. */
  agentId: string;
  botToken: string;
  chatId: string;
}

/**
 * Resolve which bot can deliver a Telegram message for a job. A gate often fires
 * inside a DELEGATED sub-job whose agent has no bot (e.g. director) — the bot
 * that reaches the user belongs to the ORCHESTRATOR, not the worker. Walk
 * parent_job_id from the gated job upward and return the first job whose agent
 * has a bot token, carrying the chat_id down the chain. Returns null when no
 * agent in the chain has a bot or no chat_id is set (→ dashboard-only job).
 *
 * DEFENSE-IN-DEPTH: the walk must never cross an entity boundary. A corrupt or
 * foreign parent_job_id (bug, or a future cross-entity delegation feature)
 * would otherwise route a delivery — and for approvals, the ✅/❌ card itself —
 * to ANOTHER entity's bot + chat. The starting job's entity_id is captured up
 * front; the moment an ancestor's entity_id diverges, the walk stops and
 * returns null (fail loud) rather than silently continuing into another
 * tenant's data.
 */
export async function resolveTelegramDeliveryTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<TelegramDeliveryTarget | null> {
  let current: string | null = jobId;
  let chatId: string | null = null;
  let startEntityId: string | null | undefined;
  for (let hops = 0; current && hops < 8; hops += 1) {
    const [row] = await db
      .select({
        parentJobId: agentJobs.parentJobId,
        chatId: agentJobs.chatId,
        entityId: agentJobs.entityId,
        agentId: agents.id,
        botToken: agents.telegramBotToken,
      })
      .from(agentJobs)
      .innerJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(eq(agentJobs.id, current))
      .limit(1);
    if (!row) break;
    if (startEntityId === undefined) {
      startEntityId = row.entityId;
    } else if (row.entityId !== startEntityId) {
      console.error(
        `[approval-notify] SECURITY: delivery walk crossed an entity boundary — ` +
          `starting job ${jobId} (entity ${startEntityId}) reached ancestor job ${current} ` +
          `(entity ${row.entityId}). Aborting the walk, no delivery target resolved.`,
      );
      return null;
    }
    // Encrypted at rest since 2026-08-28 — the walk hands the token straight
    // to the Telegram API, so it must be the plaintext. A row that cannot be
    // decrypted aborts THIS walk (no delivery target) rather than shipping
    // ciphertext to api.telegram.org, which would fail as an opaque 401.
    let bt: string | null = null;
    if (row.botToken !== null) {
      try {
        bt = decryptChannelSecret(row.botToken, `telegram bot token (agent ${row.agentId})`);
      } catch (err) {
        console.error(
          `[approval-notify agent=${row.agentId}] ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
    const rc: string | null = row.chatId ?? chatId;
    if (bt !== null && rc !== null) {
      return { agentId: row.agentId, botToken: bt, chatId: rc };
    }
    chatId = rc;
    current = row.parentJobId;
  }
  return null;
}

/**
 * Resolve the delivery target for an APPROVAL CARD specifically — SECURITY
 * (self-approval hole): `resolveTelegramDeliveryTarget` above answers "which
 * bot + chat did this job run in", which for an ordinary reply is exactly
 * right, but for an approve/reject card is wrong whenever the job was
 * triggered by a `member` chat (an authorized non-owner — H-1 onboarding).
 * Sending the buttons back to that SAME chat lets the member tap ✅ on their
 * own gated action. The card must instead always land in the bot OWNER's
 * private chat — the owner is the one who can actually authorize the agent's
 * actions.
 *
 * Resolves by walking the delegation chain (as above) to find the delivering
 * bot, then swapping its chat_id for the `role='owner', status='active'` row
 * on `telegram_allowed_chats`. A job run by the owner's own chat is already
 * the owner chat, so this is a no-op there (no behavior change for the common
 * case) — only a guest/member-triggered job sees the card move.
 *
 * An active `member` row always implies an `owner` row exists (H-1's
 * onboarding flow: nobody becomes `member` before someone is `owner`), so the
 * "no owner found" branch is a defensive fail-loud, not an expected path — it
 * returns null (no Telegram card; the approval stays resolvable from the
 * dashboard) rather than ever falling back to the triggering chat.
 */
export async function resolveApprovalDeliveryTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<TelegramDeliveryTarget | null> {
  const base = await resolveTelegramDeliveryTarget(db, jobId);
  if (!base) return null;
  const [ownerRow] = await db
    .select({ chatId: telegramAllowedChats.chatId })
    .from(telegramAllowedChats)
    .where(
      and(
        eq(telegramAllowedChats.agentId, base.agentId),
        eq(telegramAllowedChats.role, 'owner'),
        eq(telegramAllowedChats.status, 'active'),
      ),
    )
    .limit(1);
  if (!ownerRow) return null;
  return { agentId: base.agentId, botToken: base.botToken, chatId: ownerRow.chatId };
}

// ─── Channel-parametric delivery target (W2) ─────────────────────────────────
//
// The Telegram-specific resolvers above stay UNTOUCHED (byte-identical
// behavior — their own tests assert on the {agentId, botToken, chatId} shape
// directly). This section generalizes delivery to discord/slack/whatsapp
// without disturbing that contract: notifyApprovalCreated below calls ONLY
// resolveChannelApprovalDeliveryTarget, which delegates straight to
// resolveApprovalDeliveryTarget for the telegram case and wraps its result.

/** Channel-neutral approval delivery target. */
export interface ChannelApprovalDeliveryTarget {
  channel: ChannelKind;
  /** The agent whose binding is actually delivering (may differ from the
   *  gated job's own agent on a delegated chain — same "orchestrator
   *  delivers" rule as the Telegram walk). */
  agentId: string;
  credentials: ChannelCredentials;
  conversationId: string;
}

/** Hop bound mirrors resolveTelegramDeliveryTarget's — a delegation chain
 *  this deep is already a bug, not a legitimate case to keep climbing for. */
const DELIVERY_CHAIN_MAX_HOPS = 8;

/**
 * Walk parent_job_id from `jobId` up to its root, collecting each hop's
 * (agentId, channel) — entity-boundary guarded exactly like
 * resolveTelegramDeliveryTarget's walk (a corrupt/foreign parentJobId must
 * never let this cross into another tenant's data). Returns the hops in
 * order from `jobId` itself up to the root, or null if the boundary was
 * crossed or the starting job doesn't even resolve to an agent.
 */
export async function walkJobChainToRoot(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<Array<{
  agentId: string;
  channel: string | null;
  chatId: string | null;
  chatChannel: string | null;
}> | null> {
  const chain: Array<{
    agentId: string;
    channel: string | null;
    chatId: string | null;
    chatChannel: string | null;
  }> = [];
  let current: string | null = jobId;
  let startEntityId: string | null | undefined;
  for (let hops = 0; current && hops < DELIVERY_CHAIN_MAX_HOPS; hops += 1) {
    const [row] = await db
      .select({
        agentId: agentJobs.agentId,
        channel: agentJobs.channel,
        chatId: agentJobs.chatId,
        chatChannel: agentJobs.chatChannel,
        parentJobId: agentJobs.parentJobId,
        entityId: agentJobs.entityId,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, current))
      .limit(1);
    if (!row) break;
    const agentId = row.agentId;
    if (!agentId) break;
    if (startEntityId === undefined) {
      startEntityId = row.entityId;
    } else if (row.entityId !== startEntityId) {
      console.error(
        `[approval-notify] SECURITY: delivery walk crossed an entity boundary — ` +
          `starting job ${jobId} (entity ${startEntityId}) reached ancestor job ${current} ` +
          `(entity ${row.entityId}). Aborting the walk, no delivery target resolved.`,
      );
      return null;
    }
    chain.push({ agentId, channel: row.channel, chatId: row.chatId, chatChannel: row.chatChannel });
    current = row.parentJobId;
  }
  return chain.length > 0 ? chain : null;
}

/**
 * Resolve the channel-neutral delivery target for an approval card. The
 * TRANSPORT channel is decided by the job chain's ROOT (the job with no
 * parent) — a delegated sub-job's own `channel` column is usually 'internal'
 * and tells us nothing about where the human actually is; the root's channel
 * (run through resolveTransportChannel — cron/webhook/api/dashboard default
 * to 'telegram', the only channel that predates this generalization) is the
 * one that reflects how the whole chain was triggered.
 *
 * channel='telegram': delegates straight to resolveApprovalDeliveryTarget
 * above — EXACT existing behavior, wrapped into the neutral shape.
 *
 * channel=discord/slack/whatsapp: walks the SAME chain (self out to root)
 * looking for the first agent with an ENABLED binding for that channel —
 * mirrors the telegram walk's "first bot in the chain that can deliver"
 * rule. Once found, the card's conversationId is ALWAYS that agent's OWNER
 * conversation (resolveOwnerConversation) — never the triggering
 * conversation — for the exact self-approval reason resolveApprovalDeliveryTarget
 * documents above (an authorized non-owner must never approve their own
 * gated action). No owner on record, or no usable credentials, → null
 * (fail loud — dashboard-only), matching Telegram's own fail-loud contract
 * rather than ever falling back to the triggering conversation.
 *
 * The root's `channel` column defaults via resolveTransportChannel + the
 * ROOT agent's own active channels (listActiveChannelsForAgent) when it
 * isn't itself a transport (cron, webhook, dashboard, api, …) — an agent
 * bound only to Discord gets its approval card there instead of failing on
 * an unconfigured Telegram binding, falling back to 'telegram' only when the
 * root agent has no active channel at all.
 */
export async function resolveChannelApprovalDeliveryTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<ChannelApprovalDeliveryTarget | null> {
  const chain = await walkJobChainToRoot(db, jobId);
  if (!chain) return null;

  const rootHop = chain[chain.length - 1]!;
  const activeChannels = await listActiveChannelsForAgent(db, rootHop.agentId);
  const rootChannel = resolveTransportChannel(rootHop.channel, activeChannels);

  if (rootChannel === 'telegram') {
    const target = await resolveApprovalDeliveryTarget(db, jobId);
    if (!target) return null;
    return {
      channel: 'telegram',
      agentId: target.agentId,
      credentials: { botToken: target.botToken },
      conversationId: target.chatId,
    };
  }

  for (const hop of chain) {
    const binding = await getChannelBinding(db, hop.agentId, rootChannel);
    if (!binding || !binding.enabled) continue;

    const conversationId = await resolveOwnerConversation(db, hop.agentId, rootChannel);
    if (!conversationId) return null;

    const credentials = await getBindingCredentials(db, hop.agentId, rootChannel);
    if (!credentials) return null;

    return { channel: rootChannel, agentId: hop.agentId, credentials, conversationId };
  }
  return null;
}

/**
 * Render a short, human-readable summary of the gated action. PLAIN TEXT (no
 * Markdown) on purpose — tool input (e.g. an arbitrary shell command) must not be
 * able to break formatting or inject entities.
 */
export function describeGatedAction(toolName: string, toolInput: unknown): string {
  // NOUVEAU-1: mask secret-bearing fields before they reach the Telegram card.
  // The default case below dumps the whole input as JSON — for create_connector
  // / create_mcp / attach_mcp that would print the API key / stdio env values in
  // clear. run_command's `command` is not a secret field, so it is untouched.
  const input = redactSecretsForAudit(toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  switch (toolName) {
    case 'run_command':
      return `run_command:\n${str(input['command'])}`;
    case 'run_skill_script':
      return (
        `run_skill_script: ${str(input['skill'])} → ${str(input['script'])}` +
        (Array.isArray(input['args']) ? ` ${(input['args'] as unknown[]).map(str).join(' ')}` : '')
      );
    case 'skill_file_write':
      return `skill_file_write: ${str(input['skill'])} → ${str(input['path'])}`;
    default: {
      // Generic: tool name + a compact, truncated view of the input.
      const compact = str(input);
      return `${toolName}: ${compact.length > 300 ? compact.slice(0, 300) + '…' : compact}`;
    }
  }
}

/**
 * Send the deterministic approval card to the job's Telegram chat, with inline
 * approve/reject buttons. Best-effort: any failure is logged and swallowed — a
 * notification failure must never break the (already-persisted) approval gate.
 * No-ops silently when the job has no Telegram chat or the agent has no bot
 * token (e.g. dashboard/api/cron jobs) — those resolve from the dashboard.
 */
export async function notifyApprovalCreated(
  deps: RunnerDeps,
  req: ApprovalGateRequest,
): Promise<void> {
  try {
    // ── 0145 — la question d'un serveur MCP va là où la DEMANDE est née ──────
    // Sa propre livraison : la conversation d'ORIGINE (pas celle du
    // propriétaire), ses images, une carte qu'on remplit sur place.
    if (req.kind === 'elicitation') {
      await deliverElicitationToOrigin(deps, req);
      return;
    }

    // Resolve the bot/gateway + conversation that must receive the approval
    // card. On a delegated chain the gated job's own agent may have no
    // binding — the orchestrator's delivers. And regardless of who triggered
    // the job, the card always goes to the OWNER's conversation (never the
    // triggering one — see resolveApprovalDeliveryTarget /
    // resolveChannelApprovalDeliveryTarget). null ⇒ no binding anywhere in
    // the chain, no owner on record, or no usable credentials → stay silent
    // (dashboard-only).
    const target = await resolveChannelApprovalDeliveryTarget(deps.db, req.jobId);
    if (!target) return;
    const { channel, credentials, conversationId } = target;

    // #637 — la carte envoyée est CONSIGNÉE (canal, binding, conversation,
    // message) : c'est ce qui permet de la réécrire quand la demande est
    // tranchée par un autre chemin que le clic sur elle-même. Consigner n'est
    // pas facultatif, mais un échec ici ne doit pas faire croire que la carte
    // n'est pas partie : il est dit, avec ce qu'il coûte.
    const record = async (sent: SendResult): Promise<void> => {
      try {
        await recordApprovalCardMessage(deps.db, {
          approvalRequestId: req.approvalRequestId,
          channel,
          agentId: target.agentId,
          conversationId,
          messageId: sent.messageId,
        });
      } catch (err) {
        console.warn(
          `[approval-notify] card for ${req.approvalRequestId} was sent on ${channel} ` +
            `(message ${sent.messageId}) but could not be recorded — it will NOT be updated ` +
            `when the request is settled elsewhere: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    // The acting agent (whose action is gated) names the card — NOT the bot owner.
    const [agent] = await deps.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, req.agentId))
      .limit(1);
    const who = agent?.name ?? 'An agent';

    // ── P10a — une QUESTION n'est pas une approbation ─────────────────────────
    //
    // Elle ne demande pas « laisses-tu faire ceci ? » mais « laquelle ? ». Le
    // corps est donc la voix de l'agent seule (invariant #2 : sa question,
    // verbatim), et les boutons portent ses options plutôt qu'un ✅/❌.
    //
    // `readQuestionInput` rendant null (une ligne dont l'entrée ne se lit pas),
    // on retombe sur la carte d'approbation : elle sait afficher n'importe
    // quelle entrée, et une question sans carte serait un job suspendu en
    // silence — exactement ce que ce module existe pour empêcher.
    const adapterForKind = getAdapter(channel);

    const question = req.kind === 'question' ? readQuestionToolInput(req.toolInput) : null;
    if (question) {
      const hasButtons =
        adapterForKind.capabilities.buttons && adapterForKind.sendQuestionCard !== undefined;
      const text = buildQuestionCardBody({
        who,
        question: question.question,
        context: question.context,
        hasButtons,
      });
      if (hasButtons && adapterForKind.sendQuestionCard) {
        const card: QuestionCard = {
          text,
          options: question.options,
          callbackId: `${APPROVAL_CALLBACK_PREFIX}:${req.approvalRequestId}`,
        };
        await record(await adapterForKind.sendQuestionCard(credentials, conversationId, card));
      } else {
        // LIMITE ASSUMÉE de P10a : un canal sans boutons (WhatsApp) ne permet
        // pas de répondre en ligne. Les options sont numérotées pour que la
        // question reste lisible, et le dashboard tranche. Lire un numéro dans
        // un message entrant supposerait de rattacher ce message à CETTE
        // question, ce qui est un autre problème — pas un repli qu'on improvise.
        const numbered = question.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
        await record(
          await adapterForKind.sendText(credentials, conversationId, `${text}\n\n${numbered}`),
        );
      }
      return;
    }
    // Three tiers, WHY first: (1) the agent's own plain-language purpose —
    // invariant #2 applies here, this is the agent's voice, so we show it
    // verbatim or admit it's missing rather than invent one; (2) a
    // deterministic, code-computed impact line (invariant #2 does NOT apply —
    // this is platform UI describing what the action DOES, never the
    // agent's voice); (3) the raw technical detail (command/path), secondary
    // and truncated — the reviewer decides on 1+2, not on a wall of shell.
    // The card used to be: the agent's purpose, ONE impact sentence, then a raw
    // dump. For a THIRD-PARTY tool that sentence fell into
    // computeApprovalImpactLine's `default:` branch and read "irreversible or
    // destructive action" — about a call that merely fetched a CHANGELOG off
    // GitHub. Reported live: "je ne comprends pas ce que j'approuve".
    //
    // explainApprovalRequest resolves where the tool actually comes from (which
    // MCP server, at which endpoint, with which description THAT server
    // supplies) and words it accordingly, instead of guessing. Arguments are
    // redacted inside it — an approval card gets forwarded and screenshotted.
    const body = await buildApprovalCardBody(deps.db, {
      entityId: req.entityId,
      agentId: req.agentId,
      toolName: req.toolName,
      toolInput: req.toolInput,
      who,
    });

    // Channel-neutral (W2): sent through the ChannelAdapter rather than the
    // Telegram helper directly. `callbackId` carries the `apr:<id>` prefix so
    // the adapter's own `:a`/`:r` suffixing reproduces approvalCallbackData's
    // EXACT format — approval-callback.ts's parser is unchanged.
    //
    // Not every channel can render buttons (capabilities.buttons — WhatsApp
    // today): sendApprovalCard is only called when the adapter actually
    // implements it; otherwise this falls back to a plain sendText with an
    // explicit dashboard pointer, closing the silent-swallow hole a bare
    // `sendApprovalCard!` non-null assertion would otherwise hit on an
    // adapter that never implements it (an approval on such a channel used
    // to deliver NOTHING with no error).
    const adapter = getAdapter(channel);
    if (adapter.capabilities.buttons && adapter.sendApprovalCard) {
      const text = `${body}\n\nTap a button below to decide — or resolve it from the dashboard.`;
      const card: ApprovalCard = {
        text,
        approveLabel: APPROVAL_BUTTON_LABELS.approve,
        rejectLabel: APPROVAL_BUTTON_LABELS.reject,
        // Troisième action (lot approbations, parité avec le bouton web
        // « Toujours pour cet outil ») : seul l'adapter Telegram la rend
        // aujourd'hui — le flux de confirmation par édition de message vit
        // dans telegram/approval-callback.ts. Les autres adapters l'ignorent.
        alwaysLabel: APPROVAL_BUTTON_LABELS.always,
        callbackId: `${APPROVAL_CALLBACK_PREFIX}:${req.approvalRequestId}`,
      };
      await record(await adapter.sendApprovalCard(credentials, conversationId, card));
    } else {
      const text = `${body}\n\nApprove or reject from the dashboard: Approvals page.`;
      await record(await adapter.sendText(credentials, conversationId, text));
    }
  } catch (err) {
    console.warn(
      `[approval-notify] failed to send approval card for ${req.approvalRequestId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ─── 0145 — la question d'un serveur MCP, sur le canal de la demande ──────────

/**
 * Où la DEMANDE d'un job est née : le canal et la conversation de son job
 * racine, et le bot qui y livre déjà les réponses de l'agent (sur une chaîne
 * déléguée, l'orchestrateur — la même règle que `resolveTelegramDeliveryTarget`).
 *
 * null quand la demande n'est pas née sur un canal de messages (web, MCP, API,
 * routine) ou que plus rien ne permet d'y écrire : sa question reste alors sur
 * le dashboard. Jamais la conversation du propriétaire à la place : une
 * question posée ailleurs que là où l'on a demandé est une question perdue
 * (règle du propriétaire, 01/10).
 */
export async function resolveElicitationOriginTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<ChannelApprovalDeliveryTarget | null> {
  const chain = await walkJobChainToRoot(db, jobId);
  if (!chain) return null;
  const root = chain[chain.length - 1]!;
  if (!isTransportChannel(root.channel)) return null;
  // Le chat de la demande, sur SON canal seulement (#657, `jobChatOn`) : un id
  // de chat porté vers une autre plateforme n'atteint personne, ou quelqu'un
  // d'autre.
  const chatId = jobChatOn({ id: root.chatId, channel: root.chatChannel }, root.channel);
  if (!chatId) return null;
  if (root.channel === 'telegram') {
    const target = await resolveTelegramDeliveryTarget(db, jobId);
    if (!target) return null;
    return {
      channel: 'telegram',
      agentId: target.agentId,
      credentials: { botToken: target.botToken },
      conversationId: chatId,
    };
  }
  for (const hop of chain) {
    const binding = await getChannelBinding(db, hop.agentId, root.channel);
    if (!binding || !binding.enabled) continue;
    const credentials = await getBindingCredentials(db, hop.agentId, root.channel);
    if (!credentials) return null;
    return {
      channel: root.channel,
      agentId: hop.agentId,
      credentials,
      conversationId: chatId,
    };
  }
  return null;
}

/** L'extension de fichier d'une image jointe, pour le nom que le canal affiche. */
const IMAGE_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * La question d'un serveur MCP, posée dans la conversation où la demande est
 * née : ses images d'abord (`nodal/attachments`, chacune avec sa légende),
 * puis UNE carte qu'on remplit sur place — un bouton par choix, Yes / No par
 * interrupteur, ✏️ pour un nombre ou un texte à taper en réponse, Send /
 * Decline. La carte est consignée (#637) : chaque geste la réécrit, et la
 * décision, d'où qu'elle vienne, la règle.
 *
 * Un canal sans boutons (WhatsApp), ou dont les boutons ne suffisent pas au
 * formulaire, reçoit la question et le renvoi au dashboard, avec la raison —
 * jamais une carte amputée.
 */
async function deliverElicitationToOrigin(
  deps: RunnerDeps,
  req: ApprovalGateRequest,
): Promise<void> {
  const target = await resolveElicitationOriginTarget(deps.db, req.jobId);
  if (!target) {
    console.warn(
      `[approval-notify] question ${req.approvalRequestId} stays on the dashboard: ` +
        'its request was not made on a messaging channel this agent can still reach',
    );
    return;
  }
  const loaded = await loadElicitationCard(deps.db, req.approvalRequestId);
  if (!loaded.ok) {
    console.warn(
      `[approval-notify] question ${req.approvalRequestId} has no card (${loaded.reason}); ` +
        'it stays on the dashboard',
    );
    return;
  }
  const { state } = loaded;
  const { channel, credentials, conversationId } = target;
  const adapter = getAdapter(channel);

  // The card says its images are "above": it is sent only when every one of
  // them was. Otherwise the question goes with the dashboard pointer, and says
  // how many images are only there (invariant #4).
  let imagesNotSent = 0;
  if (state.imageCount > 0) {
    if (!adapter.capabilities.media) {
      imagesNotSent = state.imageCount;
      console.warn(
        `[approval-notify] ${channel} cannot carry images: the ${state.imageCount} image(s) of ` +
          `question ${req.approvalRequestId} are on the dashboard only`,
      );
    } else {
      const images = await deps.db
        .select({
          position: approvalRequestAttachments.position,
          mimeType: approvalRequestAttachments.mimeType,
          data: approvalRequestAttachments.data,
          caption: approvalRequestAttachments.caption,
        })
        .from(approvalRequestAttachments)
        .where(eq(approvalRequestAttachments.approvalRequestId, req.approvalRequestId))
        .orderBy(approvalRequestAttachments.position);
      for (const image of images) {
        try {
          await adapter.sendMedia(credentials, conversationId, {
            kind: 'photo',
            bytes: Buffer.from(image.data, 'base64'),
            filename: `image-${image.position + 1}.${IMAGE_EXTENSION[image.mimeType] ?? 'img'}`,
            ...(image.caption ? { caption: image.caption } : {}),
          });
        } catch (err) {
          imagesNotSent += 1;
          console.warn(
            `[approval-notify] image ${image.position} of question ${req.approvalRequestId} ` +
              `was not delivered on ${channel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // A pointer to the dashboard, not a card: nothing on it answers, so it is
  // not recorded as one (a reply to it is an ordinary message). It quotes the
  // server's question: where the channel has cards, it goes as a card with no
  // button, whose text is never formatted and notifies nobody.
  const pointToDashboard = async (why: string): Promise<void> => {
    console.warn(`[approval-notify] question ${req.approvalRequestId}: ${why}`);
    const text = `${buildElicitationCardBody({ server: state.asked.server, message: state.asked.message })}\n(${why}.)`;
    if (adapter.sendCard)
      await adapter.sendCard(credentials, conversationId, { text, buttons: [] });
    else await adapter.sendText(credentials, conversationId, text);
  };
  const card = renderElicitationCardFor(state, channel);
  if (!card.ok || !adapter.sendCard || imagesNotSent > 0) {
    await pointToDashboard(
      !adapter.sendCard
        ? `${channel} has no buttons to fill a form with`
        : imagesNotSent > 0
          ? `${imagesNotSent} image${imagesNotSent === 1 ? '' : 's'} of this question could not be ` +
            `sent on ${channel}: see ${imagesNotSent === 1 ? 'it' : 'them'} on the dashboard`
          : `this form does not fit on ${channel}: ${card.ok ? '' : card.reason}`,
    );
    return;
  }
  let sent: SendResult;
  try {
    sent = await adapter.sendCard(credentials, conversationId, {
      text: card.text,
      buttons: card.buttons,
    });
  } catch (err) {
    // The card did not leave (rate limit, revoked key, a keyboard the channel
    // refused): the question still reaches the conversation, with the reason.
    await pointToDashboard(
      `the card could not be sent on ${channel}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  try {
    await recordApprovalCardMessage(deps.db, {
      approvalRequestId: req.approvalRequestId,
      channel,
      agentId: target.agentId,
      conversationId,
      messageId: sent.messageId,
    });
  } catch (err) {
    console.warn(
      `[approval-notify] card for ${req.approvalRequestId} was sent on ${channel} ` +
        `(message ${sent.messageId}) but could not be recorded — its buttons will not answer: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
