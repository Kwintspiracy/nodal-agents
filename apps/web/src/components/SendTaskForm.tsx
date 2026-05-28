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
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const router = useRouter();

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

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
        className="px-4 py-2 text-sm font-medium bg-ink text-canvas rounded-lg hover:brightness-[0.92] transition-colors"
      >
        + Send task
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="bg-paper border border-rule-2 rounded-xl p-5 space-y-4 max-w-lg"
    >
      <h3 className="text-sm font-semibold text-ink">Send a task</h3>

      <div>
        <label className="block text-xs text-ink-3 mb-1" htmlFor="task-prompt">
          Task description
        </label>
        <textarea
          id="task-prompt"
          name="prompt"
          required
          rows={6}
          placeholder="Summarise the last 10 emails from my inbox…"
          className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none resize-y min-h-[80px]"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-ink-3 mb-1" htmlFor="task-agent">
            Assign to
          </label>
          <select
            id="task-agent"
            name="agentId"
            required
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
          <label className="block text-xs text-ink-3 mb-1" htmlFor="task-priority">
            Priority
          </label>
          <select
            id="task-priority"
            name="priority"
            defaultValue="medium"
            className="w-full bg-hover border border-rule rounded-lg px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      {selectedAgent?.telegramBotToken && selectedAgent?.lastSeenChatIdTelegram && (
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            name="sendViaTelegram"
            value="true"
            className="rounded border border-rule bg-hover accent-white"
          />
          Send result via Telegram (chat: {selectedAgent.lastSeenChatIdTelegram})
        </label>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 text-sm font-semibold bg-ink text-canvas rounded-lg hover:brightness-[0.92] transition-colors disabled:opacity-50"
        >
          {isPending ? 'Sending…' : 'Send task'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 py-2 text-sm font-medium border border-rule text-ink-3 rounded-lg hover:border-rule transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
