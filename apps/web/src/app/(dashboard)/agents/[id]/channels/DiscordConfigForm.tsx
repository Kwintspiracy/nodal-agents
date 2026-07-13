'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  configureAgentChannelAction,
  disconnectAgentChannelAction,
  type DiscordConfigRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';

/**
 * Discord's connect/disconnect form — same shape as TelegramConfigForm, but
 * goes through the channel-neutral actions (channel='discord') since Discord
 * has no legacy per-agent columns to update.
 */
export default function DiscordConfigForm({
  agentId,
  initialConfig,
}: {
  agentId: string;
  initialConfig: DiscordConfigRow;
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
      const result = await configureAgentChannelAction({
        agentId,
        channel: 'discord',
        credentials: { botToken: token },
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig({ ...config, status: 'connected', identityLabel: result.data.identityLabel });
      setToken('');
      toast.success(`Connected as ${result.data.identityLabel}`);
      router.refresh();
    });
  }

  function performDisconnect() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await disconnectAgentChannelAction({ agentId, channel: 'discord' });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig({ ...config, status: 'disconnected', identityLabel: null });
      toast.success('Discord disconnected');
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
        {config.identityLabel && (
          <p className="text-xs text-ink-3 mt-1.5">
            Bot: <span className="font-mono text-ink-2">{config.identityLabel}</span>
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
            placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4.G…"
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
        title="Disconnect Discord bot?"
        message="Incoming messages to this bot will stop being processed. You can reconnect later by pasting the token again."
        confirmLabel="Disconnect"
        onConfirm={performDisconnect}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
