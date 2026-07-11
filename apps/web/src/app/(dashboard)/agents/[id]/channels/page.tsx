import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getAgentChannelsAction,
  getAgentTelegramConfigAction,
  getTelegramAllowedChatsAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import TelegramChannelCard from './TelegramChannelCard.tsx';
import ComingSoonChannelCard from './ComingSoonChannelCard.tsx';

export const dynamic = 'force-dynamic';

/**
 * Generalizes the old per-agent /telegram page into a Channels grid (S4 of
 * the multichannel plan) — one card per messaging platform. Telegram is the
 * only one with a real adapter today; its card is the pre-S4 config
 * experience unchanged (TelegramChannelCard), the others render a
 * "coming soon" placeholder. See getAgentChannelsAction (actions.ts) for the
 * overview read and TelegramChannelCard for why the Telegram-specific detail
 * still comes from getAgentTelegramConfigAction directly.
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

  return (
    <PageShell title="Channels" subtitle={overview.data.agentSlug}>
      <div className="space-y-6">
        <div>
          <Link href="/agents" className="text-xs text-ink-3 hover:text-ink-2 transition-colors">
            ← Agents
          </Link>
          <p className="text-sm text-ink-3 mt-2">
            Connect this agent to a messaging platform. Telegram is ready today — Discord, Slack,
            and WhatsApp are coming soon.
          </p>
        </div>

        <div className="space-y-4">
          <TelegramChannelCard cfg={telegramCfg} allowedChats={allowedChats} />
          <ComingSoonChannelCard channel="discord" />
          <ComingSoonChannelCard channel="slack" />
          <ComingSoonChannelCard channel="whatsapp" />
        </div>
      </div>
    </PageShell>
  );
}
