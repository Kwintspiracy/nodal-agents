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

      <details className="text-sm text-ink-3">
        <summary className="cursor-pointer hover:text-ink-2">How to create the bot</summary>
        <ol className="mt-3 ml-5 list-decimal space-y-2">
          <li>
            You need a Discord <strong>server you own</strong> (bots can only be messaged — even in
            DM — by people who share a server with them). No server yet? In the Discord app, click
            the <span className="font-mono text-ink-2">+</span> button in the left column →{' '}
            <span className="font-mono text-ink-2">Create My Own</span>.
          </li>
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
            → <span className="font-mono text-ink-2">New Application</span> (top right) → give it a
            name (this becomes the bot&apos;s name) → accept the terms →{' '}
            <span className="font-mono text-ink-2">Create</span>. You land on the app&apos;s
            settings page.
          </li>
          <li>
            In the <strong>left sidebar</strong>, click{' '}
            <span className="font-mono text-ink-2">Bot</span>. Scroll down to the{' '}
            <span className="font-mono text-ink-2">Privileged Gateway Intents</span> section and
            switch ON <span className="font-mono text-ink-2">Server Members Intent</span> AND{' '}
            <span className="font-mono text-ink-2">Message Content Intent</span> —{' '}
            <strong>without the second one the bot receives empty messages</strong>. A{' '}
            <span className="font-mono text-ink-2">Save Changes</span> bar pops up at the bottom of
            the page — <strong>click it</strong>, the toggles do not save themselves.
          </li>
          <li>
            Still on the <span className="font-mono text-ink-2">Bot</span> page, near the top: click{' '}
            <span className="font-mono text-ink-2">Reset Token</span> (Discord may ask for your
            password or 2FA code) → copy the token. It is shown <strong>only once</strong> — if you
            lose it, just reset again.
          </li>
          <li>
            Left sidebar → <span className="font-mono text-ink-2">OAuth2</span>. Scroll to the{' '}
            <span className="font-mono text-ink-2">OAuth2 URL Generator</span> section. In{' '}
            <span className="font-mono text-ink-2">Scopes</span>, tick{' '}
            <span className="font-mono">bot</span> and{' '}
            <span className="font-mono">applications.commands</span> — a{' '}
            <span className="font-mono text-ink-2">Bot Permissions</span> grid then{' '}
            <strong>appears below</strong>: tick <span className="font-mono">View Channels</span>,{' '}
            <span className="font-mono">Send Messages</span>,{' '}
            <span className="font-mono">Read Message History</span>,{' '}
            <span className="font-mono">Attach Files</span>,{' '}
            <span className="font-mono">Embed Links</span>.
          </li>
          <li>
            Copy the <span className="font-mono text-ink-2">Generated URL</span> at the very bottom,
            open it in a new tab, pick <strong>your server</strong> in the dropdown →{' '}
            <span className="font-mono text-ink-2">Authorize</span>. The bot appears in your
            server&apos;s member list (offline is normal — it wakes up at the next step).
          </li>
          <li>
            Paste the token in the field above →{' '}
            <span className="font-mono text-ink-2">Connect</span>. Then send the bot a{' '}
            <strong>DM</strong> (right-click it in the member list →{' '}
            <span className="font-mono text-ink-2">Message</span>): the first private message claims
            you as its owner.
          </li>
        </ol>
      </details>
    </div>
  );
}
