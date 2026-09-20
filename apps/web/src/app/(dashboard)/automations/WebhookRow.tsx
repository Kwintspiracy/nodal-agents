'use client';

import Link from 'next/link';
import type { WebhookTriggerRow as WebhookTriggerRowData } from '@/lib/actions.ts';
import StatusPill from '@/components/ui/StatusPill';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { composeWebhookUrl } from './webhook-url.ts';
import { CHANNEL_LABELS } from './NotifyChannelFields.tsx';
import { relativeTime } from '@/lib/format-time';
import WebhookActions, { type Revealed } from './WebhookActions.tsx';

interface Props {
  webhook: WebhookTriggerRowData;
  /** Set only when the secret was created/rotated THIS session — the secret
   *  is never re-fetchable, so a page reload drops back to the hidden state. */
  revealed?: Revealed;
  onRevealed: (id: string, revealed: Revealed) => void;
}

export default function WebhookRow({ webhook: w, revealed, onRevealed }: Props) {
  return (
    /* Ancre stable (issue #55), la même que pour une routine : les deux cartes
       de `/automations` se désignent par `automation-card`, et leur genre par
       `data-automation-kind`. */
    <div
      data-testid="automation-card"
      data-automation-kind="webhook"
      className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Le nom OUVRE l'automatisation (#202), comme pour une routine, et
                le lien vit DANS le titre pour la même raison. */}
            <h3 className="text-base font-semibold text-ink">
              <Link href={`/automations/${w.id}`} className="hover:underline">
                {w.name}
              </Link>
            </h3>
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

        <WebhookActions webhook={w} onRevealed={onRevealed} />
      </div>

      {revealed && (
        <SetUrl
          subtitle="Webhook URL, contains the secret. Treat it like a password."
          url={composeWebhookUrl(revealed.path)}
        />
      )}
    </div>
  );
}
