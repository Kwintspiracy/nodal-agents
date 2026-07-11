'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  configureAgentChannelAction,
  disconnectAgentChannelAction,
  type SlackConfigRow,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';

/**
 * Slack's connect/disconnect form — same shape as DiscordConfigForm, but
 * takes TWO tokens (bot + app-level, socket mode needs both) instead of one,
 * and goes through the channel-neutral actions (channel='slack') since Slack
 * has no legacy per-agent columns to update.
 */
export default function SlackConfigForm({
  agentId,
  initialConfig,
}: {
  agentId: string;
  initialConfig: SlackConfigRow;
}) {
  const router = useRouter();
  const [config, setConfig] = useState(initialConfig);
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!botToken || !appToken) return;
    startTransition(async () => {
      const result = await configureAgentChannelAction({
        agentId,
        channel: 'slack',
        credentials: { botToken, appToken },
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig({ ...config, status: 'connected', identityLabel: result.data.identityLabel });
      setBotToken('');
      setAppToken('');
      toast.success(`Connected as ${result.data.identityLabel}`);
      router.refresh();
    });
  }

  function performDisconnect() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await disconnectAgentChannelAction({ agentId, channel: 'slack' });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setConfig({ ...config, status: 'disconnected', identityLabel: null });
      toast.success('Slack disconnected');
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
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="xoxb-…"
            className="mt-2 w-full px-3 py-2 bg-canvas border border-rule-2 rounded-lg text-sm font-mono text-ink placeholder:text-ink-4 focus:outline-none focus:border-rule"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-2 uppercase tracking-wider">App token</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            placeholder="xapp-…"
            className="mt-2 w-full px-3 py-2 bg-canvas border border-rule-2 rounded-lg text-sm font-mono text-ink placeholder:text-ink-4 focus:outline-none focus:border-rule"
          />
        </label>
        <div className="flex items-center gap-2">
          <PrimaryButton
            type="submit"
            variant="ink"
            size="sm"
            disabled={isPending || !botToken || !appToken}
          >
            {isPending ? 'Saving…' : connected ? 'Replace tokens' : 'Connect'}
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
        title="Disconnect Slack app?"
        message="Incoming messages to this app will stop being processed. You can reconnect later by pasting both tokens again."
        confirmLabel="Disconnect"
        onConfirm={performDisconnect}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
