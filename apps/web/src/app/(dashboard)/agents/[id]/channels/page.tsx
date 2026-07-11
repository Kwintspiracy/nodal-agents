import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getAgentChannelsAction,
  getAgentTelegramConfigAction,
  getTelegramAllowedChatsAction,
  getAgentDiscordConfigAction,
  getAgentSlackConfigAction,
  getChannelAllowedConversationsAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import TelegramChannelCard from './TelegramChannelCard.tsx';
import DiscordChannelCard from './DiscordChannelCard.tsx';
import SlackChannelCard from './SlackChannelCard.tsx';
import WhatsAppChannelCard from './WhatsAppChannelCard.tsx';

export const dynamic = 'force-dynamic';

/**
 * Generalizes the old per-agent /telegram page into a Channels grid (S4 of
 * the multichannel plan) — one card per messaging platform. Telegram,
 * Discord (D3), Slack (K3), and WhatsApp (W3) all have real adapters today —
 * every CHANNEL_ORDER entry now renders its full config experience
 * (TelegramChannelCard / DiscordChannelCard / SlackChannelCard /
 * WhatsAppChannelCard), none left as a "coming soon" placeholder. See
 * getAgentChannelsAction (actions.ts) for the overview read — Telegram's
 * detail still comes from getAgentTelegramConfigAction (its own legacy
 * columns), Discord's and Slack's from getAgentDiscordConfigAction /
 * getAgentSlackConfigAction (channel_bindings, no legacy columns); WhatsApp's
 * coarse connected/disconnected split comes straight off the overview (its
 * live substatus — qr_pending/open/logged_out — is polled client-side from
 * the runner by WhatsAppConfigForm).
 */
export default async function AgentChannelsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const overview = await getAgentChannelsAction(id);
  if (!overview.ok) {
    if (overview.code === 'not_found') notFound();
    return (
      <PageShell title="Channels">
        <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 text-sm text-err">
          {overview.message}
        </div>
      </PageShell>
    );
  }

  const telegramCfgResult = await getAgentTelegramConfigAction(id);
  if (!telegramCfgResult.ok) {
    // getAgentChannelsAction already confirmed the agent exists — a failure
    // here means something else broke (db_error), not a 404.
    return (
      <PageShell title="Channels" subtitle={overview.data.agentSlug}>
        <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 text-sm text-err">
          {telegramCfgResult.message}
        </div>
      </PageShell>
    );
  }
  const telegramCfg = telegramCfgResult.data;
  const allowlistResult = await getTelegramAllowedChatsAction(id);
  const allowedChats = allowlistResult.ok ? allowlistResult.data : [];

  const discordCfgResult = await getAgentDiscordConfigAction(id);
  if (!discordCfgResult.ok) {
    return (
      <PageShell title="Channels" subtitle={overview.data.agentSlug}>
        <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 text-sm text-err">
          {discordCfgResult.message}
        </div>
      </PageShell>
    );
  }
  const discordCfg = discordCfgResult.data;
  const discordAllowlistResult = await getChannelAllowedConversationsAction(id, 'discord');
  const discordAllowedConversations = discordAllowlistResult.ok ? discordAllowlistResult.data : [];

  const slackCfgResult = await getAgentSlackConfigAction(id);
  if (!slackCfgResult.ok) {
    return (
      <PageShell title="Channels" subtitle={overview.data.agentSlug}>
        <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 text-sm text-err">
          {slackCfgResult.message}
        </div>
      </PageShell>
    );
  }
  const slackCfg = slackCfgResult.data;
  const slackAllowlistResult = await getChannelAllowedConversationsAction(id, 'slack');
  const slackAllowedConversations = slackAllowlistResult.ok ? slackAllowlistResult.data : [];

  // WhatsApp has no legacy columns and no per-channel config action of its
  // own (see the header note) — its coarse status comes straight off the
  // overview already fetched above.
  const whatsappStatus =
    overview.data.channels.find((c) => c.channel === 'whatsapp')?.status === 'connected'
      ? 'connected'
      : 'disconnected';
  const whatsappAllowlistResult = await getChannelAllowedConversationsAction(id, 'whatsapp');
  const whatsappAllowedConversations = whatsappAllowlistResult.ok
    ? whatsappAllowlistResult.data
    : [];

  return (
    <PageShell title="Channels" subtitle={overview.data.agentSlug}>
      <div className="space-y-6">
        <div>
          <Link href="/agents" className="text-xs text-ink-3 hover:text-ink-2 transition-colors">
            ← Agents
          </Link>
          <p className="text-sm text-ink-3 mt-2">
            Connect this agent to a messaging platform — Telegram, Discord, Slack, and WhatsApp are
            all ready today.
          </p>
        </div>

        <div className="space-y-4">
          <TelegramChannelCard cfg={telegramCfg} allowedChats={allowedChats} />
          <DiscordChannelCard cfg={discordCfg} allowedConversations={discordAllowedConversations} />
          <SlackChannelCard cfg={slackCfg} allowedConversations={slackAllowedConversations} />
          <WhatsAppChannelCard
            agentId={overview.data.agentId}
            agentSlug={overview.data.agentSlug}
            status={whatsappStatus}
            allowedConversations={whatsappAllowedConversations}
          />
        </div>
      </div>
    </PageShell>
  );
}
