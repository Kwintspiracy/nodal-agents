'use client';

import { useState } from 'react';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PrimaryButton from '@/components/ui/PrimaryButton';
import type { AgentRow, ScheduleRow as ScheduleRowData } from '@/lib/actions.ts';
import ScheduleForm from './ScheduleForm.tsx';
import ScheduleRow from './ScheduleRow.tsx';

interface Props {
  agents: AgentRow[];
  schedules: ScheduleRowData[];
}

/**
 * AutomationsClient — owns the create-form open state so the "New schedule"
 * trigger can live in the page toolbar (right-aligned) while the form renders
 * in the body. The schedule list stays in the body.
 */
export default function AutomationsClient({ agents, schedules }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const active = schedules.filter((s) => s.active).length;

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
      </div>
    </PageShell>
  );
}
