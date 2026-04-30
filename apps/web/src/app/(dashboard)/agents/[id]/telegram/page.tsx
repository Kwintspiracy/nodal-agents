import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAgentTelegramConfigAction } from '@/lib/actions.ts';
import TelegramConfigForm from './TelegramConfigForm.tsx';

export const dynamic = 'force-dynamic';

export default async function AgentTelegramPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getAgentTelegramConfigAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <div className="space-y-6 max-w-2xl">
        <h1 className="text-2xl font-bold text-white">Telegram</h1>
        <div className="bg-red-950/30 border border-red-900/50 rounded-xl px-5 py-4 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  const cfg = result.data;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link
          href="/agents"
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        >
          ← Agents
        </Link>
        <h1 className="text-2xl font-bold text-white mt-2">Telegram</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Connect a Telegram bot to <span className="font-mono text-neutral-300">{cfg.agentSlug}</span>.
          Users can then chat with the agent directly in Telegram.
        </p>
      </div>

      {!cfg.publicUrlConfigured && (
        <div className="bg-amber-950/30 border border-amber-900/50 rounded-xl px-5 py-4 text-sm text-amber-200">
          <p className="font-semibold mb-1">Runner not publicly reachable</p>
          <p className="text-amber-300/80">
            <span className="font-mono">RUNNER_PUBLIC_URL</span> is not set, so we can save your bot
            token but Telegram can&apos;t deliver messages here yet. Expose the runner publicly
            (ngrok, Cloudflare Tunnel, or a deployed instance) and re-save the token to register
            the webhook.
          </p>
        </div>
      )}

      <TelegramConfigForm
        agentId={cfg.agentId}
        initialConfig={cfg}
      />

      <details className="text-sm text-neutral-500">
        <summary className="cursor-pointer hover:text-neutral-300">How to get a bot token</summary>
        <ol className="mt-3 ml-5 list-decimal space-y-1.5">
          <li>
            Open{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-500 hover:underline"
            >
              @BotFather
            </a>{' '}
            on Telegram.
          </li>
          <li>
            Send <span className="font-mono text-neutral-300">/newbot</span> and follow the prompts
            to pick a name and username.
          </li>
          <li>BotFather replies with a token of the form <span className="font-mono">123456789:ABC...</span> — paste it above.</li>
          <li>
            For group chats: also send <span className="font-mono text-neutral-300">/setprivacy</span>{' '}
            → choose your bot → <span className="font-mono">Disable</span> so it can read all
            messages, otherwise it only sees commands.
          </li>
        </ol>
      </details>
    </div>
  );
}
