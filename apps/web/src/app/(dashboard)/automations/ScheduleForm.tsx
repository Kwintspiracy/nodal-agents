'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createScheduleAction, type AgentRow } from '@/lib/actions.ts';

interface Props {
  agents: AgentRow[];
}

const CRON_EXAMPLES = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 09:00', value: '0 9 * * *' },
  { label: 'Weekdays at 09:00', value: '0 9 * * 1-5' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
];

export default function ScheduleForm({ agents }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [cronExpr, setCronExpr] = useState('0 9 * * *');

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    startTransition(async () => {
      const r = await createScheduleAction({
        agentId: fd.get('agentId'),
        name: fd.get('name'),
        cronExpr: fd.get('cronExpr'),
        task: fd.get('task'),
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success('Schedule created');
        form.reset();
        setCronExpr('0 9 * * *');
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={agents.length === 0}
        className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
        title={agents.length === 0 ? 'Create an agent first' : ''}
      >
        + New schedule
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-white">New schedule</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="schedule-agent">
            Agent
          </label>
          <select
            id="schedule-agent"
            name="agentId"
            required
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            <option value="">Select…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="schedule-name">
            Name
          </label>
          <input
            id="schedule-name"
            name="name"
            required
            placeholder="Daily standup"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="schedule-cron">
          Cron expression
        </label>
        <input
          id="schedule-cron"
          name="cronExpr"
          required
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          placeholder="0 9 * * *"
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none font-mono"
        />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {CRON_EXAMPLES.map((ex) => (
            <button
              key={ex.value}
              type="button"
              onClick={() => setCronExpr(ex.value)}
              className="px-2 py-1 text-[11px] font-medium border border-neutral-800 text-neutral-500 rounded hover:border-neutral-700 hover:text-white"
            >
              <span className="font-mono mr-1">{ex.value}</span>·{' '}
              <span className="text-neutral-600">{ex.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="schedule-task">
          Task instructions
        </label>
        <textarea
          id="schedule-task"
          name="task"
          required
          rows={4}
          placeholder="What should the agent do each time this fires?"
          className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-y"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create schedule'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-md hover:border-neutral-600"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
