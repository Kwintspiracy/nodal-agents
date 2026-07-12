'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Pause, PencilSimple, Copy, Trash } from '@phosphor-icons/react';
import {
  toggleScheduleAction,
  deleteScheduleAction,
  duplicateScheduleAction,
  runScheduleNowAction,
  type AgentRow,
  type ScheduleRow as ScheduleRowData,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import ScheduleForm from './ScheduleForm.tsx';
import { humanLabel } from '@/lib/cron.ts';
import StatusPill from '@/components/ui/StatusPill';
import RowActionButton from '@/components/ui/RowActionButton';
import Menu from '@/components/ui/Menu';

interface Props {
  schedule: ScheduleRowData;
  agents: AgentRow[];
}

export default function ScheduleRow({ schedule: s, agents }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleScheduleAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(r.data.active ? 'Schedule enabled' : 'Schedule disabled');
    });
  }

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteScheduleAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Schedule deleted');
    });
  }

  function handleRunNow() {
    startTransition(async () => {
      const r = await runScheduleNowAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Running "${s.name}" now`);
    });
  }

  function handleDuplicate() {
    startTransition(async () => {
      const r = await duplicateScheduleAction(s.id);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Duplicated "${s.name}" — paused; enable it when ready`);
    });
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <ScheduleForm mode="edit" agents={agents} initial={s} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{s.name}</h3>
            <StatusPill
              variant={s.active ? 'done' : 'idle'}
              label={s.active ? 'Active' : 'Paused'}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
            <span>{humanLabel(s.cronExpr)}</span>
            {s.agentName && (
              <>
                <span className="text-rule">·</span>
                <span>
                  {s.agentName} <span className="font-mono text-ink-4">{s.agentSlug}</span>
                </span>
              </>
            )}
            {s.notifyOnSuccess && (
              <>
                <span className="text-rule">·</span>
                <span title="Sends you a Telegram confirmation when it succeeds">🔔 Notifies</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-ink-4">
            {s.nextRun && s.active && <span>Next run {new Date(s.nextRun).toLocaleString()}</span>}
            {s.lastRun && (
              <span>
                Last run {new Date(s.lastRun).toLocaleString()}
                {s.lastStatus && (
                  <span
                    className={`ml-1 ${
                      s.lastStatus === 'success'
                        ? 'text-ok'
                        : s.lastStatus === 'failed'
                          ? 'text-err'
                          : s.lastStatus === 'budget_exhausted'
                            ? 'text-warn'
                            : 'text-ink-4'
                    }`}
                  >
                    ({s.lastStatus === 'budget_exhausted' ? 'budget reached' : s.lastStatus})
                  </span>
                )}
              </span>
            )}
            {s.lastStatus === 'budget_exhausted' && (
              <span title={`Paused until tomorrow — spent its $${s.dailyBudgetUsd} daily budget`}>
                💰
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <RowActionButton
            icon={<Play size={13} weight="fill" />}
            onClick={handleRunNow}
            disabled={isPending || !s.task}
            title={s.task ? 'Run this automation now, outside its schedule' : 'No task to run'}
          >
            Run now
          </RowActionButton>
          <RowActionButton
            icon={s.active ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
            onClick={handleToggle}
            disabled={isPending}
          >
            {s.active ? 'Pause' : 'Enable'}
          </RowActionButton>
          <Menu
            items={[
              {
                label: 'Edit',
                icon: <PencilSimple size={13} />,
                onSelect: () => setEditing(true),
                disabled: isPending,
              },
              {
                label: 'Duplicate',
                icon: <Copy size={13} />,
                onSelect: handleDuplicate,
                disabled: isPending,
              },
              {
                label: 'Delete',
                icon: <Trash size={13} />,
                onSelect: () => setConfirmOpen(true),
                tone: 'danger',
                disabled: isPending,
              },
            ]}
          />
        </div>
      </div>

      {s.task && (
        <details className="rounded-md border border-rule bg-canvas">
          <summary className="cursor-pointer px-3 py-2 text-xs text-ink-3 hover:text-ink-2">
            Task instructions
          </summary>
          <pre className="whitespace-pre-wrap px-3 pb-3 text-xs text-ink-2">{s.task}</pre>
        </details>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete schedule?"
        message="This cron schedule will be removed. Past runs are kept for audit."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
