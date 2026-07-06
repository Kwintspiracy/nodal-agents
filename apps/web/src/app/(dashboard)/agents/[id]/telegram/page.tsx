import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAgentTelegramConfigAction, getTelegramAllowedChatsAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import TelegramConfigForm from './TelegramConfigForm.tsx';
import TelegramAllowlist from './TelegramAllowlist.tsx';

export const dynamic = 'force-dynamic';

export default async function AgentTelegramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getAgentTelegramConfigAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Telegram">
        <div className="bg-warn-bg border border-err/30 rounded-xl px-5 py-4 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
    );
  }

  const cfg = result.data;
  const allowlistResult = await getTelegramAllowedChatsAction(id);
  const allowedChats = allowlistResult.ok ? allowlistResult.data : [];

  return (
    <PageShell title="Telegram" subtitle={cfg.agentSlug}>
      <div className="space-y-6">
        <div>
          <Link href="/agents" className="text-xs text-ink-3 hover:text-ink-2 transition-colors">
            ← Agents
          </Link>
          <p className="text-sm text-ink-3 mt-2">
            Connect a Telegram bot to <span className="font-mono text-ink-2">{cfg.agentSlug}</span>.
            The runner long-polls Telegram for new messages — no public URL needed.
          </p>
        </div>

        <TelegramConfigForm agentId={cfg.agentId} initialConfig={cfg} />

        {cfg.status === 'connected' && (
          <TelegramAllowlist agentId={cfg.agentId} chats={allowedChats} />
        )}

        <div className="bg-paper border border-rule-2 rounded-xl px-5 py-4 space-y-1">
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
    </PageShell>
  );
}
