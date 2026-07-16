import type {
  TelegramConfigRow,
  TelegramAllowedChatView,
  DiscordConfigRow,
  SlackConfigRow,
  ChannelAllowedConversationView,
} from '@/lib/actions.ts';
import TelegramChannelCard from '../channels/TelegramChannelCard.tsx';
import DiscordChannelCard from '../channels/DiscordChannelCard.tsx';
import SlackChannelCard from '../channels/SlackChannelCard.tsx';
import WhatsAppChannelCard from '../channels/WhatsAppChannelCard.tsx';

/**
 * ChannelsTabContent — the Channels tab panel on the agent composer.
 *
 * This used to be its own page (/agents/[id]/channels); Quentin corrected
 * that to a real in-page tab (one canonical surface, no extra navigation
 * hop) — the standalone route now just redirects here with `?tab=channels`
 * (see ../channels/page.tsx). The card components themselves
 * (Telegram/Discord/Slack/WhatsAppChannelCard, and everything they render —
 * config forms, connect guides, allowlists) are reused unchanged from that
 * page; only the data-loading moved up into edit/page.tsx alongside the
 * composer's other per-agent reads.
 */
export default function ChannelsTabContent({
  agentId,
  agentSlug,
  error,
  telegramCfg,
  telegramAllowedChats,
  discordCfg,
  discordAllowedConversations,
  slackCfg,
  slackAllowedConversations,
  whatsappStatus,
  whatsappAllowedConversations,
}: {
  agentId: string;
  agentSlug: string;
  /** Set when one of the channel reads hit a genuine db_error — the agent's
   *  own existence is already confirmed by the composer page, so this is an
   *  edge case, not the common "not found" path. */
  error: string | null;
  telegramCfg: TelegramConfigRow | null;
  telegramAllowedChats: TelegramAllowedChatView[];
  discordCfg: DiscordConfigRow | null;
  discordAllowedConversations: ChannelAllowedConversationView[];
  slackCfg: SlackConfigRow | null;
  slackAllowedConversations: ChannelAllowedConversationView[];
  whatsappStatus: 'connected' | 'disconnected';
  whatsappAllowedConversations: ChannelAllowedConversationView[];
}) {
  if (error || !telegramCfg || !discordCfg || !slackCfg) {
    return (
      <div className="rounded-xl border border-err/30 bg-warn-bg px-5 py-4 text-sm text-err">
        {error ?? 'Failed to load channels.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-body-13 text-ink-3">
        Connect this agent to a messaging platform — Telegram, Discord, Slack, and WhatsApp are all
        ready today.
      </p>
      <div className="space-y-4">
        <TelegramChannelCard cfg={telegramCfg} allowedChats={telegramAllowedChats} />
        <DiscordChannelCard cfg={discordCfg} allowedConversations={discordAllowedConversations} />
        <SlackChannelCard cfg={slackCfg} allowedConversations={slackAllowedConversations} />
        <WhatsAppChannelCard
          agentId={agentId}
          agentSlug={agentSlug}
          status={whatsappStatus}
          allowedConversations={whatsappAllowedConversations}
        />
      </div>
    </div>
  );
}
