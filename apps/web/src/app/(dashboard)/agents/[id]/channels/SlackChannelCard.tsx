import type { SlackConfigRow, ChannelAllowedConversationView } from '@/lib/actions.ts';
import SlackConfigForm from './SlackConfigForm.tsx';
import ChannelAllowlist from './ChannelAllowlist.tsx';
import SlackConnectGuide from './SlackConnectGuide.tsx';

/**
 * Slack's card in the Channels grid — same shell TelegramChannelCard/
 * DiscordChannelCard use, backed by the channel-neutral actions
 * (channel_bindings / channel_allowed_conversations) since Slack has no
 * legacy per-agent columns.
 */
export default function SlackChannelCard({
  cfg,
  allowedConversations,
}: {
  cfg: SlackConfigRow;
  allowedConversations: ChannelAllowedConversationView[];
}) {
  return (
    <div id="slack" className="bg-paper border border-rule-2 rounded-xl px-5 py-5 space-y-5">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand svg, same convention as ConnectorsInstalledTable */}
        <img
          src="/channel-icons/slack.svg"
          alt=""
          aria-hidden="true"
          className="h-9 w-9 shrink-0"
        />
        <div>
          <p className="text-sm font-medium text-ink">Slack</p>
          <p className="text-xs text-ink-3">
            Talk to <span className="font-mono text-ink-2">{cfg.agentSlug}</span> from a Slack DM or
            channel.
          </p>
        </div>
      </div>

      <SlackConfigForm agentId={cfg.agentId} initialConfig={cfg} />

      {cfg.status === 'connected' && (
        <ChannelAllowlist agentId={cfg.agentId} chats={allowedConversations} />
      )}

      <SlackConnectGuide />
    </div>
  );
}
