import type { TelegramConfigRow, TelegramAllowedChatView } from '@/lib/actions.ts';
import TelegramConfigForm from './TelegramConfigForm.tsx';
import TelegramAllowlist from './TelegramAllowlist.tsx';

/**
 * Telegram's card in the Channels grid — the pre-S4 /telegram page's content,
 * unchanged functionally, just wrapped in the same card shell every channel
 * uses. TelegramConfigForm/TelegramAllowlist are untouched (still call the
 * telegram-named actions, now thin delegations — see actions.ts).
 */
export default function TelegramChannelCard({
  cfg,
  allowedChats,
}: {
  cfg: TelegramConfigRow;
  allowedChats: TelegramAllowedChatView[];
}) {
  return (
    <div id="telegram" className="bg-paper border border-rule-2 rounded-xl px-5 py-5 space-y-5">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand svg, same convention as ConnectorsInstalledTable */}
        <img
          src="/channel-icons/telegram.svg"
          alt=""
          aria-hidden="true"
          className="h-9 w-9 shrink-0"
        />
        <div>
          <p className="text-sm font-medium text-ink">Telegram</p>
          <p className="text-xs text-ink-3">
            Talk to <span className="font-mono text-ink-2">{cfg.agentSlug}</span> from your phone —
            the runner long-polls Telegram, no public URL needed.
          </p>
        </div>
      </div>

      <TelegramConfigForm agentId={cfg.agentId} initialConfig={cfg} />

      {cfg.status === 'connected' && (
        <TelegramAllowlist agentId={cfg.agentId} chats={allowedChats} />
      )}

      <div className="bg-canvas border border-rule-2 rounded-xl px-4 py-3 space-y-1">
        <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">
          Last connected chat
        </p>
        {cfg.lastSeenChatIdTelegram ? (
          <p className="text-sm text-ink-2 font-mono">{cfg.lastSeenChatIdTelegram}</p>
        ) : (
          <p className="text-sm text-ink-3">
            No chat seen yet — DM the bot from your Telegram account to register a recipient.
          </p>
        )}
      </div>

      <details className="text-sm text-ink-3">
        <summary className="cursor-pointer hover:text-ink-2">How to get a bot token</summary>
        <ol className="mt-3 ml-5 list-decimal space-y-1.5">
          <li>
            Open{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ok hover:underline"
            >
              @BotFather
            </a>{' '}
            on Telegram.
          </li>
          <li>
            Send <span className="font-mono text-ink-2">/newbot</span> and follow the prompts to
            pick a name and username.
          </li>
          <li>
            BotFather replies with a token of the form{' '}
            <span className="font-mono">123456789:ABC...</span> — paste it above.
          </li>
          <li>
            For group chats: also send <span className="font-mono text-ink-2">/setprivacy</span> →
            choose your bot → <span className="font-mono">Disable</span> so it can read all
            messages, otherwise it only sees commands.
          </li>
        </ol>
      </details>
    </div>
  );
}
