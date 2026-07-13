'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  configureAgentTelegramAction,
  disconnectAgentTelegramAction,
  type TelegramConfigRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';

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
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    startTransition(async () => {
      const result = await configureAgentTelegramAction({ agentId, botToken: token });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig(result.data);
      setToken('');
      toast.success(`Connected as @${result.data.botUsername}`);
      router.refresh();
    });
  }

  function performDisconnect() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await disconnectAgentTelegramAction(agentId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig({ ...config, status: 'disconnected', botUsername: null });
      toast.success('Telegram disconnected');
      router.refresh();
    });
  }

  const connected = config.status === 'connected';

  return (
    <div className="space-y-5">
      {/* Status block */}
      <div className="bg-paper border border-rule-2/60 rounded-xl px-5 py-4">
        <div className="flex items-center gap-2">
          <span
            className={
              connected
                ? 'inline-block w-2 h-2 rounded-full bg-agent-vivid'
                : 'inline-block w-2 h-2 rounded-full bg-ink-4'
            }
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-ink">
            {connected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        {config.botUsername && (
          <p className="text-xs text-ink-3 mt-1.5">
            Bot:{' '}
            <a
              href={`https://t.me/${config.botUsername}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-ink-2 hover:text-ok"
            >
              @{config.botUsername}
            </a>
          </p>
        )}
      </div>

      {/* Configure form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-ink-2 uppercase tracking-wider">Bot token</span>
          <TextInput
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:ABCDEF…"
            containerClassName="mt-2"
            className="font-mono"
          />
        </label>
        <div className="flex items-center gap-2">
          <PrimaryButton type="submit" variant="ink" size="sm" disabled={isPending || !token}>
            {isPending ? 'Saving…' : connected ? 'Replace token' : 'Connect'}
          </PrimaryButton>
          {connected && (
            <PrimaryButton
              type="button"
              variant="neutral"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={isPending}
            >
              Disconnect
            </PrimaryButton>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={confirmOpen}
        title="Disconnect Telegram bot?"
        message="Incoming messages to this bot will stop being processed. You can reconnect later by pasting the token again."
        confirmLabel="Disconnect"
        onConfirm={performDisconnect}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
