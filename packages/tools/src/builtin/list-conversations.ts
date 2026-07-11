// Built-in: list_conversations
//
// Lets an agent discover the conversations available on a connected messaging
// platform (Telegram, Discord, Slack, WhatsApp) — server/channel/group
// structure, plus which ones it is already owner-approved to send to.
// Capability-driven, like the 6 send tools in ../communication: registered
// per-job by the runner only when the agent has ≥1 enabled channel binding
// (same gate as telegram_send_message et al. — see apps/runner/src/job/execute.ts).
//
// Born from a live incident: an agent with an ENABLED Discord binding told its
// owner "I have no Discord connection" — bindings were never surfaced to the
// LLM at all. This tool (plus the "## Messaging channels" system-prompt block
// in @nodal-agents/orchestration) closes that gap.
//
// Telegram bots cannot enumerate the chats that have messaged them (a
// platform limitation of the Bot API, not a Nodal gap) — for that channel the
// tool returns the approved-conversation allowlist itself, which IS the
// agent's complete view of Telegram. Every other channel calls the adapter's
// own `listConversations` (when implemented) and MERGES the result with the
// allowlist so the agent sees approved vs. not-yet-approved in one call.

import { z } from 'zod';
import {
  getChannelBinding,
  listChannelBindings,
  getBindingCredentials,
  listAllowedConversations,
} from '@nodal-agents/db';
import { getAdapter } from '@nodal-agents/delivery';
import type { ToolDefinition, ToolContext } from '../types';

/** Bound the result so a platform with thousands of channels/DMs never blows the context. */
const MAX_ROWS = 150;

// ─── Input / Output ───────────────────────────────────────────────────────────

const ListConversationsInput = z.object({
  channel: z
    .enum(['telegram', 'discord', 'slack', 'whatsapp'])
    .describe('The connected messaging platform to explore.'),
});

type ListConversationsInput = z.infer<typeof ListConversationsInput>;

interface ConversationEntry {
  conversationId: string;
  name?: string;
  kind: string;
  groupName?: string;
  /** True when this conversation is on this agent's approved allowlist. */
  approved: boolean;
  /** Only present when approved — 'owner' or 'member'. */
  role?: string;
}

interface ListConversationsOutput {
  channel: string;
  conversations: ConversationEntry[];
  /** Explains a platform limitation or fallback path, when relevant. */
  note?: string;
  truncated?: boolean;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the list_conversations tool definition.
 *
 * Factory shape so the definition is stateless — all state (bindings,
 * credentials, allowlist rows) is resolved at execute-time from ctx.
 */
export function createListConversationsTool(): ToolDefinition<
  typeof ListConversationsInput,
  ListConversationsOutput
> {
  return {
    name: 'list_conversations',
    description: `Explore a connected messaging platform's structure (servers, channels, groups, DMs) and see which conversations you're already approved to send to.

- **channel**: which connected platform to explore (telegram, discord, slack, whatsapp).

Telegram bots cannot enumerate the chats that have messaged them (a platform limitation) — for Telegram this returns your approved-conversation list, which IS your complete view of that channel. For other platforms it returns the platform's own conversation list, each marked \`approved: true/false\` (plus your \`role\` when approved) against your allowlist. Use this before sending to a conversation other than the current one — the send tools' optional \`channel\` argument only works for conversations that are already approved.

Fail conditions:
- No enabled binding for the requested channel → throws \`channel_not_connected\`, naming the channels you ARE connected to.
- The channel is bound but has no usable credentials → throws \`channel_not_connected\`.
- WhatsApp is connected but its device isn't paired yet → throws \`whatsapp_not_paired\`.`,

    inputSchema: ListConversationsInput,

    riskLevel: 'read',

    async execute(
      input: ListConversationsInput,
      ctx: ToolContext,
    ): Promise<ListConversationsOutput> {
      const { channel } = input;

      // 1. Gate on an enabled binding — same channel-neutral check the runner
      // uses to decide whether to register this tool at all.
      const binding = await getChannelBinding(ctx.db, ctx.agentId, channel);
      if (!binding || !binding.enabled) {
        const connected = (await listChannelBindings(ctx.db, ctx.agentId))
          .filter((b) => b.enabled)
          .map((b) => b.channel);
        const err = new Error(
          `channel_not_connected: this agent has no enabled ${channel} binding. ` +
            (connected.length > 0
              ? `Connected channels: ${connected.join(', ')}.`
              : 'This agent has no connected messaging channels yet.'),
        );
        err.name = 'channel_not_connected';
        throw err;
      }

      // 2. This agent's approval allowlist for the channel — the ground truth
      // for Telegram, and the merge source for every other channel.
      const allowlist = await listAllowedConversations(ctx.db, ctx.agentId, channel);
      const allowedById = new Map(allowlist.map((row) => [row.conversationId, row]));
      const fromAllowlist = (): ConversationEntry[] =>
        allowlist.map((row) => ({
          conversationId: row.conversationId,
          name: row.requesterName ?? undefined,
          kind: row.kind,
          approved: row.status === 'active',
          ...(row.status === 'active' ? { role: row.role } : {}),
        }));

      let entries: ConversationEntry[];
      let note: string | undefined;

      if (channel === 'telegram') {
        note =
          'Telegram bots cannot list the chats that have messaged them (platform limitation) — ' +
          'these are your approved conversations, which is your complete view of Telegram.';
        entries = fromAllowlist();
      } else {
        const adapter = getAdapter(channel);
        if (typeof adapter.listConversations !== 'function') {
          note = `${channel} does not support conversation discovery yet — these are your approved conversations only.`;
          entries = fromAllowlist();
        } else {
          const creds = await getBindingCredentials(ctx.db, ctx.agentId, channel);
          if (!creds) {
            const err = new Error(`channel_not_connected: no usable credentials for ${channel}.`);
            err.name = 'channel_not_connected';
            throw err;
          }
          // Propagates as-is on failure (e.g. `whatsapp_not_paired`) — fail loud.
          const discovered = await adapter.listConversations(creds);
          entries = discovered.map((d) => {
            const match = allowedById.get(d.conversationId);
            const approved = match?.status === 'active';
            return {
              ...d,
              approved,
              ...(approved ? { role: match!.role } : {}),
            };
          });
        }
      }

      const truncated = entries.length > MAX_ROWS;
      if (truncated) {
        entries = entries.slice(0, MAX_ROWS);
        note = note
          ? `${note} Showing the first ${MAX_ROWS} — result truncated.`
          : `Showing the first ${MAX_ROWS} — result truncated.`;
      }

      return {
        channel,
        conversations: entries,
        ...(note ? { note } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}
