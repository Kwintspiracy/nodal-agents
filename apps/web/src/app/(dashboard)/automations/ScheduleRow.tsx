'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  toggleScheduleAction,
  deleteScheduleAction,
  type AgentRow,
  type ScheduleRow as ScheduleRowData,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import ScheduleForm from './ScheduleForm.tsx';
import { humanLabel } from '@/lib/cron.ts';

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

  if (editing) {
    return (
      <div className="space-y-2">
        <ScheduleForm mode="edit" agents={agents} initial={s} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-white">{s.name}</h3>
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                s.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-800 text-neutral-500'
              }`}
            >
              {s.active ? 'active' : 'paused'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-neutral-500 flex-wrap">
            <span>{humanLabel(s.cronExpr)}</span>
            {s.agentName && (
              <>
                <span className="text-neutral-700">·</span>
                <span>
                  {s.agentName} <span className="font-mono text-neutral-600">{s.agentSlug}</span>
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-[10px] text-neutral-600">
            {s.nextRun && s.active && <span>Next run {new Date(s.nextRun).toLocaleString()}</span>}
            {s.lastRun && (
              <span>
                Last run {new Date(s.lastRun).toLocaleString()}
                {s.lastStatus && (
                  <span
                    className={`ml-1 ${
                      s.lastStatus === 'success'
                        ? 'text-emerald-400'
                        : s.lastStatus === 'failed'
                          ? 'text-red-400'
                          : 'text-neutral-500'
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
            onClick={() => setEditing(true)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
          >
            {s.active ? 'Pause' : 'Enable'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isPending}
            className="px-2.5 py-1 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>

      {s.task && (
        <details className="bg-neutral-950 border border-neutral-800/40 rounded-md">
          <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300">
            Task instructions
          </summary>
          <pre className="px-3 pb-3 text-xs text-neutral-300 whitespace-pre-wrap">{s.task}</pre>
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
