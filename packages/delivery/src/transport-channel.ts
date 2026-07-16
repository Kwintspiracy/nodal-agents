// transport-channel.ts — the default OUTBOUND transport for a job whose
// origin channel isn't itself a message transport.
//
// A job's `channel` column records how it was TRIGGERED — 'cron', 'webhook',
// 'dashboard', 'api', 'internal', … — none of which are places an agent can
// actually deliver a message. Now that all four channels (telegram, discord,
// slack, whatsapp) can ship as an agent's real transport, a non-transport
// origin defaults to the agent's FIRST active channel per CHANNEL_PRIORITY
// below — not unconditionally 'telegram'. `activeChannels` is optional: a
// caller with no way to know an agent's bindings (or one that legitimately
// has none) still gets 'telegram', preserving the pre-multichannel behavior
// and letting the loud `telegram_no_bot_token` failure downstream remain the
// signal for "this agent has no channel at all". A job whose channel IS
// already a registered transport (e.g. 'telegram', 'discord') keeps its own
// channel — it never gets redirected, regardless of `activeChannels`.
//
// Shared by delivery-guard.ts's resolveChannelForJob (send-tool dispatch),
// deliver-results.ts's and run-schedules.ts's channel-return send sites, and
// approvals/notify.ts's approval-card delivery target — all four need the
// exact same default rule, and drifting it between them would silently split
// where a job's outbound replies land.

import { agents, eq, listChannelBindings } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { ChannelKind } from './channel-adapter.ts';

/** Stable fallback order when more than one channel is active and the
 *  trigger origin gives no signal about which one to prefer. */
const CHANNEL_PRIORITY: readonly ChannelKind[] = ['telegram', 'discord', 'slack', 'whatsapp'];

const TRANSPORT_CHANNELS: ReadonlySet<string> = new Set<ChannelKind>(CHANNEL_PRIORITY);

/**
 * Resolve the transport channel to deliver on for a given job `channel`
 * value. Returns `channel` itself when it already names a registered
 * transport. Otherwise:
 *   - `activeChannels` non-empty → the first of THOSE channels in
 *     CHANNEL_PRIORITY order (the agent's real bindings, see
 *     `listActiveChannelsForAgent` below);
 *   - `activeChannels` absent or empty → `'telegram'`, the historical
 *     default — the loud `telegram_no_bot_token` failure downstream is the
 *     correct signal when an agent truly has no channel at all.
 * `channel` is `string` (not `ChannelKind`) because callers pass raw
 * `agent_jobs.channel` values, which are trigger origins, not necessarily
 * transports.
 */
export function resolveTransportChannel(
  channel: string | null | undefined,
  activeChannels?: readonly ChannelKind[],
): ChannelKind {
  if (channel && TRANSPORT_CHANNELS.has(channel)) return channel as ChannelKind;
  if (activeChannels && activeChannels.length > 0) {
    const active = new Set(activeChannels);
    const preferred = CHANNEL_PRIORITY.find((c) => active.has(c));
    if (preferred) return preferred;
  }
  return 'telegram';
}

/**
 * Every transport channel this agent has a live credential for, in
 * CHANNEL_PRIORITY order — telegram via `agents.telegram_bot_token` (the
 * transitional path every other Telegram read in @nodal-agents/db still
 * uses, see queries/channel-identity.ts's file header), every other channel
 * via an ENABLED `channel_bindings` row (`listChannelBindings`). This is the
 * SAME per-channel check apps/runner/src/job/execute.ts already does to gate
 * which comm tools a job's whitelist gets (deliveryBotToken / hasDiscordBinding
 * / hasSlackBinding) — centralized here so every caller of
 * `resolveTransportChannel` (execute.ts, deliver-results.ts, run-schedules.ts,
 * notify.ts) agrees on what "this agent's active channels" means instead of
 * re-deriving it ad hoc at each call site.
 */
export async function listActiveChannelsForAgent(
  db: AnyDrizzleDb,
  agentId: string,
): Promise<ChannelKind[]> {
  const [agentRow] = await db
    .select({ telegramBotToken: agents.telegramBotToken })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const bindings = await listChannelBindings(db, agentId);
  const enabled = new Set(bindings.filter((b) => b.enabled).map((b) => b.channel));

  const active: ChannelKind[] = [];
  if (agentRow?.telegramBotToken) active.push('telegram');
  for (const channel of CHANNEL_PRIORITY) {
    if (channel !== 'telegram' && enabled.has(channel)) active.push(channel);
  }
  return active;
}
