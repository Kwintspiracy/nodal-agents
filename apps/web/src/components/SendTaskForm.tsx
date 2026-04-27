'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { sendTaskAction } from '@/lib/actions.ts';
import type { AgentRow } from '@/lib/actions.ts';

export default function SendTaskForm({ agents }: { agents: AgentRow[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    startTransition(async () => {
      const result = await sendTaskAction(data);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Task sent — job created');
      formRef.current?.reset();
      setOpen(false);
      router.push(`/jobs/${result.data.jobId}`);
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors"
      >
        + Send task
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="bg-neutral-900 border border-neutral-800/60 rounded-xl p-5 space-y-4 max-w-lg"
    >
      <h3 className="text-sm font-semibold text-white">Send a task</h3>

      <div>
        <label className="block text-xs text-neutral-500 mb-1" htmlFor="task-title">
          Task description
        </label>
        <textarea
          id="task-title"
          name="title"
          required
          rows={3}
          placeholder="Summarise the last 10 emails from my inbox…"
          className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-neutral-500 focus:outline-none resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="task-agent">
            Assign to
          </label>
          <select
            id="task-agent"
            name="agentId"
            required
            defaultValue=""
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            <option value="" disabled>
              Select agent
            </option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.slug})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-500 mb-1" htmlFor="task-priority">
            Priority
          </label>
          <select
            id="task-priority"
            name="priority"
            defaultValue="medium"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-neutral-500 focus:outline-none"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50"
        >
          {isPending ? 'Sending…' : 'Send task'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 py-2 text-sm font-medium border border-neutral-700 text-neutral-400 rounded-lg hover:border-neutral-600 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
