'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { toggleScheduleAction, deleteScheduleAction } from '@/lib/actions.ts';

interface Props {
  id: string;
  active: boolean;
}

export default function ScheduleActions({ id, active }: Props) {
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleScheduleAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success(r.data.active ? 'Schedule enabled' : 'Schedule disabled');
    });
  }

  function handleDelete() {
    if (!confirm('Delete this schedule?')) return;
    startTransition(async () => {
      const r = await deleteScheduleAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Schedule deleted');
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        className="px-2.5 py-1 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white disabled:opacity-40"
      >
        {active ? 'Pause' : 'Enable'}
      </button>
      <button
        type="button"
        onClick={handleDelete}
        disabled={isPending}
        className="px-2.5 py-1 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
      >
        Delete
      </button>
    </div>
  );
}
