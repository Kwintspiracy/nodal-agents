import type { DiscordConfigRow, ChannelAllowedConversationView } from '@/lib/actions.ts';
import DiscordConfigForm from './DiscordConfigForm.tsx';
import ChannelAllowlist from './ChannelAllowlist.tsx';

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
    <div className="bg-paper border border-rule-2 rounded-xl px-5 py-5 space-y-5">
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-conn-vivid/15 text-base"
          aria-hidden="true"
        >
          🎮
        </span>
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

      <details className="text-sm text-ink-3">
        <summary className="cursor-pointer hover:text-ink-2">How to create the bot</summary>
        <ol className="mt-3 ml-5 list-decimal space-y-1.5">
          <li>
            Open{' '}
            <a
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ok hover:underline"
            >
              discord.com/developers/applications
            </a>{' '}
            → <span className="font-mono text-ink-2">New Application</span> →{' '}
            <span className="font-mono text-ink-2">Bot</span>.
          </li>
          <li>
            Enable <span className="font-mono text-ink-2">Server Members Intent</span> AND{' '}
            <span className="font-mono text-ink-2">Message Content Intent</span> —{' '}
            <strong>without the second one, the bot receives empty messages</strong>.
          </li>
          <li>
            <span className="font-mono text-ink-2">Reset Token</span> → copy it (shown only once).
          </li>
          <li>
            <span className="font-mono text-ink-2">OAuth2</span> tab → URL Generator: scopes{' '}
            <span className="font-mono">bot</span> +{' '}
            <span className="font-mono">applications.commands</span>, permissions{' '}
            <span className="font-mono">View Channels</span>,{' '}
            <span className="font-mono">Send Messages</span>,{' '}
            <span className="font-mono">Read Message History</span>,{' '}
            <span className="font-mono">Attach Files</span>,{' '}
            <span className="font-mono">Embed Links</span> → invite the bot to your server with the
            generated URL.
          </li>
          <li>Paste the token above.</li>
        </ol>
      </details>
    </div>
  );
}
