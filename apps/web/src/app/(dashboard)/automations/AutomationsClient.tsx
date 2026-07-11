'use client';

import { useState } from 'react';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PrimaryButton from '@/components/ui/PrimaryButton';
import type {
  AgentRow,
  ScheduleRow as ScheduleRowData,
  WebhookTriggerRow as WebhookTriggerRowData,
} from '@/lib/actions.ts';
import ScheduleForm from './ScheduleForm.tsx';
import ScheduleRow from './ScheduleRow.tsx';
import WebhookForm from './WebhookForm.tsx';
import WebhookRow from './WebhookRow.tsx';

interface Props {
  agents: AgentRow[];
  schedules: ScheduleRowData[];
  webhooks: WebhookTriggerRowData[];
}

/**
 * AutomationsClient — owns the create-form open state so the "New schedule"
 * trigger can live in the page toolbar (right-aligned) while the form renders
 * in the body. The schedule list stays in the body.
 *
 * Also owns `revealedWebhooks`: webhook secrets are write-once (list never
 * returns them), so the map of ids → {secret, path} minted by a create/rotate
 * THIS session lives here and is handed down to both WebhookForm (on create)
 * and WebhookRow (on rotate) — a page reload naturally drops back to hidden.
 */
export default function AutomationsClient({ agents, schedules, webhooks }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const active = schedules.filter((s) => s.active).length;

  const [webhookFormOpen, setWebhookFormOpen] = useState(false);
  const [revealedWebhooks, setRevealedWebhooks] = useState<
    Record<string, { secret: string; path: string }>
  >({});
  const webhooksActive = webhooks.filter((w) => w.active).length;

  return (
    <PageShell
      title="Automations"
      subtitle={`${active} active · ${schedules.length} total`}
      toolbar={
        <PageTopBar
          cta={
            <PrimaryButton
              variant="neutral"
              onClick={() => setFormOpen(true)}
              disabled={agents.length === 0}
              title={agents.length === 0 ? 'Create an agent first' : undefined}
            >
              + New schedule
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-6">
        {formOpen && <ScheduleForm agents={agents} open={formOpen} onOpenChange={setFormOpen} />}

        {schedules.length === 0 ? (
          <div className="rounded-xl border border-rule-2 bg-paper px-6 py-12 text-center text-sm text-ink-4">
            {agents.length === 0
              ? 'Create an agent first, then schedule a recurring task.'
              : 'No schedules yet. Add one with the “New schedule” button above.'}
          </div>
        ) : (
          <div className="space-y-3">
            {schedules.map((s) => (
              <ScheduleRow key={s.id} schedule={s} agents={agents} />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Webhooks</h2>
            <p className="text-xs text-ink-3">
              {webhooksActive} active · {webhooks.length} total
            </p>
          </div>
          <PrimaryButton
            variant="neutral"
            onClick={() => setWebhookFormOpen(true)}
            disabled={agents.length === 0}
            title={agents.length === 0 ? 'Create an agent first' : undefined}
          >
            + New webhook
          </PrimaryButton>
        </div>

        {webhookFormOpen && (
          <WebhookForm
            agents={agents}
            open={webhookFormOpen}
            onOpenChange={setWebhookFormOpen}
            onCreated={(id, revealed) =>
              setRevealedWebhooks((prev) => ({ ...prev, [id]: revealed }))
            }
          />
        )}

        {webhooks.length === 0 ? (
          <div className="rounded-xl border border-rule-2 bg-paper px-6 py-12 text-center text-sm text-ink-4">
            {agents.length === 0
              ? 'Create an agent first, then add a webhook to trigger it from an external service.'
              : 'No webhooks yet. A webhook gives an external service a URL that starts a task on an agent when it posts to it.'}
          </div>
        ) : (
          <div className="space-y-3">
            {webhooks.map((w) => (
              <WebhookRow
                key={w.id}
                webhook={w}
                revealed={revealedWebhooks[w.id]}
                onRevealed={(id, revealed) =>
                  setRevealedWebhooks((prev) => ({ ...prev, [id]: revealed }))
                }
              />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
