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
  resolveOwnerConversation,
} from '@nodal-agents/db';
import { redactSecretsForAudit, renderExplanationText } from '@nodal-agents/shared';
import { explainApprovalRequest } from './explain-request.ts';
import {
  getAdapter,
  resolveTransportChannel,
  listActiveChannelsForAgent,
  type ApprovalCard,
  type ChannelKind,
  type ChannelCredentials,
} from '@nodal-agents/delivery';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';

/** callback_data carried by the buttons. Parsed by approval-callback.ts. Stays well under Telegram's 64-byte cap. */
export const APPROVAL_CALLBACK_PREFIX = 'apr';
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
    const bt: string | null = row.botToken;
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
async function walkJobChainToRoot(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<Array<{ agentId: string; channel: string | null }> | null> {
  const chain: Array<{ agentId: string; channel: string | null }> = [];
  let current: string | null = jobId;
  let startEntityId: string | null | undefined;
  for (let hops = 0; current && hops < DELIVERY_CHAIN_MAX_HOPS; hops += 1) {
    const [row] = await db
      .select({
        agentId: agentJobs.agentId,
        channel: agentJobs.channel,
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
    chain.push({ agentId, channel: row.channel });
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

    // The acting agent (whose action is gated) names the card — NOT the bot owner.
    const [agent] = await deps.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, req.agentId))
      .limit(1);
    const who = agent?.name ?? 'An agent';
    // Three tiers, WHY first: (1) the agent's own plain-language purpose —
    // invariant #2 applies here, this is the agent's voice, so we show it
    // verbatim or admit it's missing rather than invent one; (2) a
    // deterministic, code-computed impact line (invariant #2 does NOT apply —
    // this is platform UI describing what the action DOES, never the
    // agent's voice); (3) the raw technical detail (command/path), secondary
    // and truncated — the reviewer decides on 1+2, not on a wall of shell.
    const input = (req.toolInput ?? {}) as Record<string, unknown>;
    const purpose = typeof input['purpose'] === 'string' ? input['purpose'].trim() : '';

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
    const explanation = await explainApprovalRequest(
      deps.db,
      req.entityId,
      req.toolName,
      req.toolInput,
    );

    const body =
      `⏳ Approbation requise — ${who}\n\n` +
      // The agent's own words stay first and verbatim (invariant #2), but they
      // are now clearly ITS voice, quoted — not the platform's verdict.
      //
      // An ABSENT purpose is stated, never left blank: "the agent did not say
      // why" is information the reviewer needs, and a silent gap reads as if
      // nothing were missing. Asserted by notify.test.ts.
      (purpose ? `« ${purpose} »\n\n` : 'Purpose not specified by the agent.\n\n') +
      renderExplanationText(explanation);

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
        approveLabel: '✅ Approve',
        rejectLabel: '❌ Reject',
        callbackId: `${APPROVAL_CALLBACK_PREFIX}:${req.approvalRequestId}`,
      };
      await adapter.sendApprovalCard(credentials, conversationId, card);
    } else {
      const text = `${body}\n\nApprove or reject from the dashboard: Approvals page.`;
      await adapter.sendText(credentials, conversationId, text);
    }
  } catch (err) {
    console.warn(
      `[approval-notify] failed to send approval card for ${req.approvalRequestId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
