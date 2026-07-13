'use client';

import { useState } from 'react';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PrimaryButton from '@/components/ui/PrimaryButton';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
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
 * / "New webhook" triggers can live in the page toolbar (right-aligned)
 * while each form renders in its own non-dismissable Modal — the same
 * pattern ScheduleRow/WebhookRow use for editing (UX-DS Phase 4: create and
 * edit share one pattern per entity, no separate inline page panel).
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
            <div className="flex items-center gap-2">
              <PrimaryButton
                variant="neutral"
                onClick={() => setFormOpen(true)}
                disabled={agents.length === 0}
                title={agents.length === 0 ? 'Create an agent first' : undefined}
              >
                + New schedule
              </PrimaryButton>
              <PrimaryButton
                variant="neutral"
                onClick={() => setWebhookFormOpen(true)}
                disabled={agents.length === 0}
                title={agents.length === 0 ? 'Create an agent first' : undefined}
              >
                + New webhook
              </PrimaryButton>
            </div>
          }
        />
      }
    >
      <div className="space-y-6">
        {/* New schedule — same non-dismissable Modal as Edit (ScheduleRow),
            not an inline page panel (UX-DS Phase 4: create vs. edit must
            share one pattern per entity). ScheduleForm renders its own "New
            schedule" heading. */}
        <Modal
          open={formOpen}
          onClose={() => setFormOpen(false)}
          dismissable={false}
          className="max-w-xl"
        >
          <ScheduleForm agents={agents} open={formOpen} onOpenChange={setFormOpen} />
        </Modal>

        {schedules.length === 0 ? (
          <EmptyState
            title={
              agents.length === 0
                ? 'Create an agent first, then schedule a recurring task.'
                : 'No schedules yet. Add one with the “New schedule” button above.'
            }
          />
        ) : (
          <div className="space-y-3">
            {schedules.map((s) => (
              <ScheduleRow key={s.id} schedule={s} agents={agents} />
            ))}
          </div>
        )}

        <div className="pt-4">
          <h2 className="text-base font-semibold text-ink">Webhooks</h2>
          <p className="text-xs text-ink-3">
            {webhooksActive} active · {webhooks.length} total
          </p>
        </div>

        {/* New webhook — same non-dismissable Modal pattern as schedules
            (UX-DS Phase 4). WebhookForm renders its own heading. */}
        <Modal
          open={webhookFormOpen}
          onClose={() => setWebhookFormOpen(false)}
          dismissable={false}
          className="max-w-xl"
        >
          <WebhookForm
            agents={agents}
            open={webhookFormOpen}
            onOpenChange={setWebhookFormOpen}
            onCreated={(id, revealed) =>
              setRevealedWebhooks((prev) => ({ ...prev, [id]: revealed }))
            }
          />
        </Modal>

        {webhooks.length === 0 ? (
          <EmptyState
            title={
              agents.length === 0
                ? 'Create an agent first, then add a webhook to trigger it from an external service.'
                : 'No webhooks yet. A webhook gives an external service a URL that starts a task on an agent when it posts to it.'
            }
          />
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
