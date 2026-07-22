'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Pause, ArrowsClockwise, Trash } from '@phosphor-icons/react';
import {
  toggleWebhookTriggerAction,
  rotateWebhookSecretAction,
  deleteWebhookTriggerAction,
  type WebhookTriggerRow as WebhookTriggerRowData,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import StatusPill from '@/components/ui/StatusPill';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { composeWebhookUrl } from './webhook-url.ts';
import RowActionButton from '@/components/ui/RowActionButton';
import { CHANNEL_LABELS } from './NotifyChannelFields.tsx';
import { relativeTime } from '@/lib/format-time';

interface Revealed {
  secret: string;
  path: string;
}

interface Props {
  webhook: WebhookTriggerRowData;
  /** Set only when the secret was created/rotated THIS session — the secret
   *  is never re-fetchable, so a page reload drops back to the hidden state. */
  revealed?: Revealed;
  onRevealed: (id: string, revealed: Revealed) => void;
}

export default function WebhookRow({ webhook: w, revealed, onRevealed }: Props) {
  const [isPending, startTransition] = useTransition();
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleWebhookTriggerAction(w.id, !w.active);
      if (!r.ok) toast.error(r.message);
      else toast.success(r.data.active ? 'Webhook enabled' : 'Webhook disabled');
    });
  }

  function performRotate() {
    setRotateConfirmOpen(false);
    startTransition(async () => {
      const r = await rotateWebhookSecretAction(w.id);
      if (!r.ok) toast.error(r.message);
      else {
        onRevealed(w.id, { secret: r.data.secret, path: r.data.path });
        toast.success('Secret rotated — the old URL no longer works');
      }
    });
  }

  function performDelete() {
    setDeleteConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteWebhookTriggerAction(w.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Webhook deleted');
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{w.name}</h3>
            <StatusPill
              variant={w.active ? 'done' : 'idle'}
              label={w.active ? 'Active' : 'Paused'}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
            {w.agentName && <span>{w.agentName}</span>}
            <span className="text-rule">·</span>
            <span>
              {w.triggerCount} {w.triggerCount === 1 ? 'fire' : 'fires'}
            </span>
            <span className="text-rule">·</span>
            <span>Last fired {relativeTime(w.lastTriggeredAt)}</span>
            {w.notifyOnSuccess && (
              <>
                <span className="text-rule">·</span>
                <span
                  title={`Sends you a confirmation via ${
                    w.notifyChannel ? (CHANNEL_LABELS[w.notifyChannel] ?? w.notifyChannel) : 'auto'
                  } when it fires successfully`}
                >
                  🔔 Notifies
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <RowActionButton
            square
            icon={w.active ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
            title={w.active ? 'Pause' : 'Enable'}
            onClick={handleToggle}
            disabled={isPending}
          />
          <RowActionButton
            square
            icon={<ArrowsClockwise size={16} />}
            title="Rotate secret"
            onClick={() => setRotateConfirmOpen(true)}
            disabled={isPending}
          />
          <RowActionButton
            square
            icon={<Trash size={16} />}
            title="Delete"
            tone="danger"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={isPending}
          />
        </div>
      </div>

      {revealed && (
        <SetUrl
          subtitle="Webhook URL — contains the secret, treat it like a password"
          url={composeWebhookUrl(revealed.path)}
        />
      )}

      <ConfirmDialog
        open={rotateConfirmOpen}
        title="Rotate webhook secret?"
        message="A new URL is generated immediately and the current one stops working — update the external service before it fires again."
        confirmLabel="Rotate"
        destructive={false}
        onConfirm={performRotate}
        onCancel={() => setRotateConfirmOpen(false)}
      />
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete webhook?"
        message="This webhook trigger is removed. Any service still posting to its URL will get a 404."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </div>
  );
}
