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
  /** When provided, the open/closed state of the create form is controlled by
   *  the parent. This lets the trigger button live elsewhere (e.g. the page
   *  toolbar) while the form renders in the page body. When omitted, the
   *  component owns its own state and renders its built-in trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface EditProps {
  mode: 'edit';
  agents: AgentRow[];
  initial: ScheduleRow;
  onDone?: () => void;
  open?: undefined;
  onOpenChange?: undefined;
}

type Props = CreateProps | EditProps;

export default function ScheduleForm(props: Props) {
  const isEdit = props.mode === 'edit';
  const controlled = !isEdit && props.open !== undefined;
  const [internalOpen, setInternalOpen] = useState(isEdit);
  const open = controlled ? (props.open ?? false) : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlled) props.onOpenChange?.(next);
    else setInternalOpen(next);
  };
  const [isPending, startTransition] = useTransition();
  // Controlled so the "no Telegram bot" warning can react to the current agent
  // + notify choices before submit.
  const [agentId, setAgentId] = useState(isEdit ? props.initial.agentId : '');
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(
    isEdit ? props.initial.notifyOnSuccess === true : false,
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    startTransition(async () => {
      if (isEdit) {
        const r = await updateScheduleAction({
          id: props.initial.id,
          agentId,
          name: fd.get('name'),
          cronExpr: fd.get('cronExpr'),
          task: fd.get('task'),
          notifyOnSuccess,
        });
        if (!r.ok) toast.error(r.message);
        else {
          toast.success('Schedule updated');
          props.onDone?.();
        }
      } else {
        const r = await createScheduleAction({
          agentId,
          name: fd.get('name'),
          cronExpr: fd.get('cronExpr'),
          task: fd.get('task'),
          notifyOnSuccess,
        });
        if (!r.ok) toast.error(r.message);
        else {
          toast.success('Schedule created');
          form.reset();
          setAgentId('');
          setNotifyOnSuccess(false);
          setOpen(false);
          props.onDone?.();
        }
      }
    });
  }

  if (!isEdit && !open) {
    // Controlled: the trigger button lives in the page toolbar — render nothing
    // here when closed.
    if (controlled) return null;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={props.agents.length === 0}
        className="inline-flex h-[34px] items-center gap-1.5 rounded-md border-0 bg-ink px-3.5 text-[14px] font-medium leading-none text-canvas transition-[filter] hover:brightness-[0.92] disabled:cursor-not-allowed disabled:opacity-40"
        title={props.agents.length === 0 ? 'Create an agent first' : ''}
      >
        + New schedule
      </button>
    );
  }

  const nameDefault = isEdit ? props.initial.name : '';
  const taskDefault = isEdit ? (props.initial.task ?? '') : '';
  const cronDefault = isEdit ? props.initial.cronExpr : '0 9 * * *';

  // Telegram delivery is per-agent (the runner sends via the executing agent's
  // own bot token). A "notify" cron on a bot-less agent can never reach the user
  // — warn instead of letting it silently no-op.
  const selectedAgent = props.agents.find((a) => a.id === agentId);
  const lacksBot = notifyOnSuccess && selectedAgent != null && !selectedAgent.telegramBotToken;

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5"
    >
      <h3 className="text-sm font-semibold text-ink">
        {isEdit ? 'Edit schedule' : 'New schedule'}
      </h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-ink-3" htmlFor="schedule-agent">
            Agent
          </label>
          <select
            id="schedule-agent"
            name="agentId"
            required
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
          <label className="mb-1 block text-xs text-ink-3" htmlFor="schedule-name">
            Name
          </label>
          <input
            id="schedule-name"
            name="name"
            required
            defaultValue={nameDefault}
            placeholder="Daily standup"
            className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink placeholder-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </div>
      </div>

      <CronBuilder name="cronExpr" initial={cronDefault} />

      <div>
        <label className="mb-1 block text-xs text-ink-3" htmlFor="schedule-task">
          Task instructions
        </label>
        <textarea
          id="schedule-task"
          name="task"
          required
          rows={4}
          defaultValue={taskDefault}
          placeholder="What should the agent do each time this fires?"
          className="w-full resize-y rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink placeholder-ink-4 focus:border-ink-3 focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2.5 rounded-md border border-rule bg-canvas px-3 py-2.5 text-sm">
          <input
            type="checkbox"
            name="notifyOnSuccess"
            checked={notifyOnSuccess}
            onChange={(e) => setNotifyOnSuccess(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
          />
          <span>
            <span className="font-medium text-ink">Notify me on Telegram when it succeeds</span>
            <span className="mt-0.5 block text-xs text-ink-3">
              The agent sends you a short confirmation each time this automation finishes. Requires
              a Telegram bot on the agent (DM it once so it knows where to reach you).
            </span>
          </span>
        </label>

        {lacksBot && (
          <p className="rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
            ⚠️ <span className="font-medium">{selectedAgent?.name}</span>
            {` has no Telegram bot, so it can't send you this confirmation. Schedule this automation on a Telegram-connected agent, or connect a bot to this one.`}
          </p>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md border-0 bg-ink px-3.5 text-[14px] font-medium leading-none text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-50"
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
          className="inline-flex h-[34px] items-center rounded-md border border-rule-2 px-3.5 text-[14px] font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
