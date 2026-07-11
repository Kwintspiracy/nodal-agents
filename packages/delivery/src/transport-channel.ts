// transport-channel.ts — the default OUTBOUND transport for a job whose
// origin channel isn't itself a message transport.
//
// A job's `channel` column records how it was TRIGGERED — 'cron', 'webhook',
// 'dashboard', 'api', 'internal', … — none of which are places an agent can
// actually deliver a message. Until other channels ship, the only real
// transport an agent has is its Telegram binding, so any non-transport
// channel defaults to 'telegram' (S3 of the multichannel plan). A job whose
// channel IS already a registered transport (e.g. 'telegram', and 'discord'
// once that adapter ships) keeps its own channel — it never gets redirected.
//
// Shared by delivery-guard.ts's resolveChannelForJob (send-tool dispatch) and
// deliver-results.ts's channel-return send site — both need the exact same
// default rule, and drifting it between the two would silently split where a
// job's outbound replies land.

import type { ChannelKind } from './channel-adapter.ts';

const TRANSPORT_CHANNELS: ReadonlySet<string> = new Set<ChannelKind>([
  'telegram',
  'discord',
  'slack',
  'whatsapp',
]);

/**
 * Resolve the transport channel to deliver on for a given job `channel`
 * value. Returns `channel` itself when it already names a registered
 * transport; otherwise defaults to `'telegram'` — the only transport that
 * exists today. `channel` is `string` (not `ChannelKind`) because callers
 * pass raw `agent_jobs.channel` values, which are trigger origins, not
 * necessarily transports.
 */
export function resolveTransportChannel(channel: string | null | undefined): ChannelKind {
  if (channel && TRANSPORT_CHANNELS.has(channel)) return channel as ChannelKind;
  return 'telegram';
}
