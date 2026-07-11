import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getAgentChannelsAction,
  getAgentTelegramConfigAction,
  getTelegramAllowedChatsAction,
  getAgentDiscordConfigAction,
  getChannelAllowedConversationsAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import TelegramChannelCard from './TelegramChannelCard.tsx';
import DiscordChannelCard from './DiscordChannelCard.tsx';
import ComingSoonChannelCard from './ComingSoonChannelCard.tsx';

export const dynamic = 'force-dynamic';

/**
 * Generalizes the old per-agent /telegram page into a Channels grid (S4 of
 * the multichannel plan) — one card per messaging platform. Telegram and
 * Discord (D3) have real adapters today; their cards are the full config
 * experience (TelegramChannelCard / DiscordChannelCard), the rest render a
 * "coming soon" placeholder. See getAgentChannelsAction (actions.ts) for the
 * overview read — Telegram's detail still comes from
 * getAgentTelegramConfigAction (its own legacy columns), Discord's from
 * getAgentDiscordConfigAction (channel_bindings, no legacy columns).
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

  return (
    <PageShell title="Channels" subtitle={overview.data.agentSlug}>
      <div className="space-y-6">
        <div>
          <Link href="/agents" className="text-xs text-ink-3 hover:text-ink-2 transition-colors">
            ← Agents
          </Link>
          <p className="text-sm text-ink-3 mt-2">
            Connect this agent to a messaging platform. Telegram and Discord are ready today — Slack
            and WhatsApp are coming soon.
          </p>
        </div>

        <div className="space-y-4">
          <TelegramChannelCard cfg={telegramCfg} allowedChats={allowedChats} />
          <DiscordChannelCard cfg={discordCfg} allowedConversations={discordAllowedConversations} />
          <ComingSoonChannelCard channel="slack" />
          <ComingSoonChannelCard channel="whatsapp" />
        </div>
      </div>
    </PageShell>
  );
}
