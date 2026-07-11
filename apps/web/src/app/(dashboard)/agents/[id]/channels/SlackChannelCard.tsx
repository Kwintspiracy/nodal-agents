import type { SlackConfigRow, ChannelAllowedConversationView } from '@/lib/actions.ts';
import SlackConfigForm from './SlackConfigForm.tsx';
import ChannelAllowlist from './ChannelAllowlist.tsx';
import SlackManifestBlock from './SlackManifestBlock.tsx';

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
    <div className="bg-paper border border-rule-2 rounded-xl px-5 py-5 space-y-5">
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

      <details className="text-sm text-ink-3">
        <summary className="cursor-pointer hover:text-ink-2">How to create the Slack app</summary>
        <div className="mt-3 space-y-3">
          <SlackManifestBlock />
          <ol className="ml-5 list-decimal space-y-1.5">
            <li>
              Open{' '}
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ok hover:underline"
              >
                api.slack.com/apps
              </a>{' '}
              → <span className="font-mono text-ink-2">Create New App</span> →{' '}
              <span className="font-mono text-ink-2">From a manifest</span> → paste the JSON above →{' '}
              <span className="font-mono text-ink-2">Create</span>.
            </li>
            <li>
              <span className="font-mono text-ink-2">Install to Workspace</span> → then copy the Bot
              Token (<span className="font-mono">xoxb-…</span>) from{' '}
              <span className="font-mono text-ink-2">Settings → Install App</span>.
            </li>
            <li>
              <span className="font-mono text-ink-2">
                Settings → Basic Information → App-Level Tokens
              </span>{' '}
              → <span className="font-mono text-ink-2">Generate</span> a token with the{' '}
              <span className="font-mono">connections:write</span> scope → copy the App Token (
              <span className="font-mono">xapp-…</span>).
            </li>
            <li>Paste both tokens above.</li>
          </ol>
          <p className="text-xs text-ink-3">
            <strong>Any change to scopes or events requires reinstalling the app</strong> to the
            workspace. The manifest above already enables the Messages Tab —{' '}
            <strong>without it, DMs to the bot are blocked</strong>.
          </p>
        </div>
      </details>
    </div>
  );
}
