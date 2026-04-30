'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  configureAgentTelegramAction,
  disconnectAgentTelegramAction,
  type TelegramConfigRow,
} from '@/lib/actions.ts';

export default function TelegramConfigForm({
  agentId,
  initialConfig,
}: {
  agentId: string;
  initialConfig: TelegramConfigRow;
}) {
  const router = useRouter();
  const [config, setConfig] = useState(initialConfig);
  const [token, setToken] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    startTransition(async () => {
      const result = await configureAgentTelegramAction({ agentId, botToken: token });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      // Server returns the new config but with empty agentName; preserve the
      // local one so the page header doesn't blink.
      setConfig({ ...result.data, agentName: config.agentName });
      setToken('');
      toast.success(
        result.data.status === 'webhook-active'
          ? `Connected as @${result.data.botUsername} — webhook registered`
          : `Bot @${result.data.botUsername} validated`,
      );
      router.refresh();
    });
  }

  function handleDisconnect() {
    if (!confirm('Disconnect this Telegram bot? Incoming messages will stop.')) return;
    startTransition(async () => {
      const result = await disconnectAgentTelegramAction(agentId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig({
        ...config,
        status: 'unconfigured',
        botUsername: null,
        webhookUrl: null,
        hasToken: false,
      });
      toast.success('Telegram disconnected');
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {/* Status block */}
      <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-4">
        <div className="flex items-center gap-2">
          <span
            className={
              config.status === 'webhook-active'
                ? 'inline-block w-2 h-2 rounded-full bg-emerald-500'
                : config.status === 'token-only'
                  ? 'inline-block w-2 h-2 rounded-full bg-amber-500'
                  : 'inline-block w-2 h-2 rounded-full bg-neutral-600'
            }
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-white">
            {config.status === 'webhook-active' && 'Connected'}
            {config.status === 'token-only' && 'Token saved (no webhook)'}
            {config.status === 'unconfigured' && 'Not connected'}
          </span>
        </div>
        {config.botUsername && (
          <p className="text-xs text-neutral-500 mt-1.5">
            Bot:{' '}
            <a
              href={`https://t.me/${config.botUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-neutral-300 hover:text-emerald-500"
            >
              @{config.botUsername}
            </a>
          </p>
        )}
        {config.webhookUrl && (
          <p className="text-xs text-neutral-600 mt-1 truncate">
            Webhook: <span className="font-mono">{config.webhookUrl}</span>
          </p>
        )}
      </div>

      {/* Configure form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-neutral-300 uppercase tracking-wider">
            Bot token
          </span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:ABCDEF…"
            className="mt-2 w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-sm font-mono text-neutral-100 placeholder:text-neutral-700 focus:outline-none focus:border-neutral-600"
          />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={isPending || !token}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending
              ? 'Saving…'
              : config.hasToken
                ? 'Replace token'
                : 'Connect'}
          </button>
          {config.hasToken && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={isPending}
              className="px-4 py-2 text-sm font-medium border border-neutral-800 text-neutral-400 rounded-lg hover:border-red-800/60 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
