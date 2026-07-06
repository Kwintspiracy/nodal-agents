'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  revokeTelegramChatAction,
  resolveTelegramChatAction,
  type TelegramAllowedChatView,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

export default function TelegramAllowlist({
  chats,
}: {
  agentId: string;
  chats: TelegramAllowedChatView[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [revokeTarget, setRevokeTarget] = useState<TelegramAllowedChatView | null>(null);

  const pending = chats.filter((c) => c.status === 'pending');
  const active = chats.filter((c) => c.status === 'active');

  function resolve(id: string, decision: 'approve' | 'deny'): void {
    startTransition(async () => {
      const r = await resolveTelegramChatAction(id, decision);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(decision === 'approve' ? 'Chat authorized' : 'Chat denied');
      router.refresh();
    });
  }

  function performRevoke(): void {
    const target = revokeTarget;
    setRevokeTarget(null);
    if (!target) return;
    startTransition(async () => {
      const r = await revokeTelegramChatAction(target.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('Access revoked');
      router.refresh();
    });
  }

  return (
    <div className="bg-paper border border-rule-2 rounded-xl px-5 py-4 space-y-4">
      <div>
        <p className="text-xs font-medium text-ink-3 uppercase tracking-wide">Authorized chats</p>
        <p className="text-sm text-ink-3 mt-1">
          Only these chats can put this agent to work. The first person to DM the bot becomes its
          owner; anyone new is held here until you approve them.
        </p>
      </div>

      {chats.length === 0 ? (
        <p className="text-sm text-ink-3">
          No chats yet — DM the bot from your Telegram account to claim ownership.
        </p>
      ) : (
        <div className="space-y-2">
          {pending.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-ink-2 truncate">
                  {c.requesterName ?? 'Unknown'}{' '}
                  <span className="text-ink-3 font-mono text-xs">({c.chatId})</span>
                </p>
                <p className="text-xs text-warn">Waiting for your approval</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => resolve(c.id, 'approve')}
                  className="text-xs rounded-md bg-ok/15 text-ok px-2.5 py-1 hover:bg-ok/25 transition-colors disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => resolve(c.id, 'deny')}
                  className="text-xs rounded-md bg-err/15 text-err px-2.5 py-1 hover:bg-err/25 transition-colors disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}

          {active.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-rule-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-ink-2 truncate">
                  {c.requesterName ?? (c.role === 'owner' ? 'Owner' : 'Member')}{' '}
                  <span className="text-ink-3 font-mono text-xs">({c.chatId})</span>
                </p>
                <p className="text-xs text-ink-3">
                  {c.role === 'owner' ? 'Owner — controls this bot' : 'Authorized'}
                </p>
              </div>
              {c.role === 'owner' ? (
                <span className="text-xs rounded-md bg-ok/15 text-ok px-2.5 py-1 shrink-0">
                  Owner
                </span>
              ) : (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setRevokeTarget(c)}
                  className="text-xs rounded-md border border-rule-2 text-ink-3 px-2.5 py-1 hover:text-err hover:border-err/40 transition-colors disabled:opacity-50 shrink-0"
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke access?"
        message={`${revokeTarget?.requesterName ?? 'This chat'} (${revokeTarget?.chatId ?? ''}) will no longer be able to message this agent. If they DM again, you'll be asked to approve them.`}
        confirmLabel="Revoke"
        onConfirm={performRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
