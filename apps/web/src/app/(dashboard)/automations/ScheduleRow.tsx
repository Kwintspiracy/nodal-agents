'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
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
          <div className="flex items-center gap-3 text-[10px] text-ink-4">
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
                          : 'text-ink-4'
                    }`}
                  >
                    ({s.lastStatus})
                  </span>
                )}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleRunNow}
            disabled={isPending || !s.task}
            title={s.task ? 'Run this automation now, outside its schedule' : 'No task to run'}
            className="rounded-md border border-rule-2 px-2.5 py-1 text-xs font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-40"
          >
            ▶ Run now
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={isPending}
            className="rounded-md border border-rule-2 px-2.5 py-1 text-xs font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDuplicate}
            disabled={isPending}
            title="Create a paused copy of this automation"
            className="rounded-md border border-rule-2 px-2.5 py-1 text-xs font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-40"
          >
            Duplicate
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={isPending}
            className="rounded-md border border-rule-2 px-2.5 py-1 text-xs font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-40"
          >
            {s.active ? 'Pause' : 'Enable'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending}
            className="rounded-md border border-err/30 px-2.5 py-1 text-xs font-medium text-err transition-colors hover:border-err/60 disabled:opacity-40"
          >
            Delete
          </button>
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
