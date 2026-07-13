import type { DiscordConfigRow, ChannelAllowedConversationView } from '@/lib/actions.ts';
import DiscordConfigForm from './DiscordConfigForm.tsx';
import ChannelAllowlist from './ChannelAllowlist.tsx';
import DiscordConnectGuide from './DiscordConnectGuide.tsx';

/**
 * Discord's card in the Channels grid — same shell TelegramChannelCard uses,
 * backed by the channel-neutral actions (channel_bindings /
 * channel_allowed_conversations) since Discord has no legacy per-agent columns.
 */
export default function DiscordChannelCard({
  cfg,
  allowedConversations,
}: {
  cfg: DiscordConfigRow;
  allowedConversations: ChannelAllowedConversationView[];
}) {
  return (
    <div id="discord" className="bg-paper border border-rule-2 rounded-xl px-5 py-5 space-y-5">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand svg, same convention as ConnectorsInstalledTable */}
        <img
          src="/channel-icons/discord.svg"
          alt=""
          aria-hidden="true"
          className="h-9 w-9 shrink-0"
        />
        <div>
          <p className="text-sm font-medium text-ink">Discord</p>
          <p className="text-xs text-ink-3">
            Talk to <span className="font-mono text-ink-2">{cfg.agentSlug}</span> from a Discord
            server or DM.
          </p>
        </div>
      </div>

      <DiscordConfigForm agentId={cfg.agentId} initialConfig={cfg} />

      {cfg.status === 'connected' && (
        <ChannelAllowlist agentId={cfg.agentId} chats={allowedConversations} />
      )}

      <DiscordConnectGuide />
    </div>
  );
}
