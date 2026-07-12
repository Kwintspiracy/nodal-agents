'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Pause, ArrowClockwise, Trash } from '@phosphor-icons/react';
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
import Menu from '@/components/ui/Menu';

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

function relativeTime(date: Date | string | null): string {
  if (!date) return 'Never';
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <RowActionButton
            icon={w.active ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
            onClick={handleToggle}
            disabled={isPending}
          >
            {w.active ? 'Pause' : 'Enable'}
          </RowActionButton>
          <Menu
            items={[
              {
                label: revealed ? 'Rotate' : 'Rotate secret…',
                icon: <ArrowClockwise size={13} />,
                onSelect: () => setRotateConfirmOpen(true),
                disabled: isPending,
              },
              {
                label: 'Delete',
                icon: <Trash size={13} />,
                onSelect: () => setDeleteConfirmOpen(true),
                tone: 'danger',
                disabled: isPending,
              },
            ]}
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
