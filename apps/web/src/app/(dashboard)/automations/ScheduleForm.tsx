'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  createScheduleAction,
  updateScheduleAction,
  type AgentRow,
  type ScheduleRow,
} from '@/lib/actions.ts';
import CronBuilder from '@/components/CronBuilder.tsx';

interface CreateProps {
  mode?: 'create';
  agents: AgentRow[];
  onDone?: () => void;
  initial?: undefined;
}

interface EditProps {
  mode: 'edit';
  agents: AgentRow[];
  initial: ScheduleRow;
  onDone?: () => void;
}

type Props = CreateProps | EditProps;

export default function ScheduleForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const [open, setOpen] = useState(isEdit);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    startTransition(async () => {
      if (isEdit) {
        const r = await updateScheduleAction({
          id: props.initial.id,
          agentId: fd.get('agentId'),
          name: fd.get('name'),
          cronExpr: fd.get('cronExpr'),
          task: fd.get('task'),
        });
        if (!r.ok) toast.error(r.message);
        else {
          toast.success('Schedule updated');
          props.onDone?.();
        }
      } else {
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
          setOpen(false);
          props.onDone?.();
        }
      }
    });
  }

  if (!isEdit && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={props.agents.length === 0}
        className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed"
        title={props.agents.length === 0 ? 'Create an agent first' : ''}
      >
        + New schedule
      </button>
    );
  }

  const agentDefault = isEdit ? props.initial.agentId : '';
  const nameDefault = isEdit ? props.initial.name : '';
  const taskDefault = isEdit ? (props.initial.task ?? '') : '';
  const cronDefault = isEdit ? props.initial.cronExpr : '0 9 * * *';

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-white">
        {isEdit ? 'Edit schedule' : 'New schedule'}
      </h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="schedule-agent">
            Agent
          </label>
          <select
            id="schedule-agent"
            name="agentId"
            required
            defaultValue={agentDefault}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            <option value="">Select…</option>
            {props.agents.map((a) => (
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
            defaultValue={nameDefault}
            placeholder="Daily standup"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
      </div>

      <CronBuilder name="cronExpr" initial={cronDefault} />

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="schedule-task">
          Task instructions
        </label>
        <textarea
          id="schedule-task"
          name="task"
          required
          rows={4}
          defaultValue={taskDefault}
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
          {isPending
            ? isEdit
              ? 'Saving…'
              : 'Creating…'
            : isEdit
              ? 'Save changes'
              : 'Create schedule'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (isEdit) props.onDone?.();
            else setOpen(false);
          }}
          className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-md hover:border-neutral-600"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
