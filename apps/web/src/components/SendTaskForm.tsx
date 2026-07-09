'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from '@phosphor-icons/react';
import { sendTaskAction } from '@/lib/actions.ts';
import type { AgentRow } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Modal from '@/components/ui/Modal';

/**
 * SendTaskForm — the "New task" CTA for the Runs page. A neutral (white) toolbar
 * button that opens a modal with the task form. Lives in the toolbar `cta`.
 */
export default function SendTaskForm({ agents }: { agents: AgentRow[] }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const router = useRouter();

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    startTransition(async () => {
      const result = await sendTaskAction(data);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Task sent — job created');
      setOpen(false);
      router.push(`/jobs/${result.data.jobId}`);
    });
  }

  return (
    <>
      <PrimaryButton variant="neutral" onClick={() => setOpen(true)}>
        <Plus size={13} weight="bold" />
        New task
      </PrimaryButton>

      <Modal open={open} onClose={() => setOpen(false)} title="New task">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-ink-3" htmlFor="task-prompt">
              Task description
            </label>
            <textarea
              id="task-prompt"
              name="prompt"
              required
              rows={6}
              placeholder="Summarise the last 10 emails from my inbox…"
              className="min-h-[80px] w-full resize-y rounded-lg border border-rule bg-hover px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-ink-3" htmlFor="task-agent">
                Assign to
              </label>
              <select
                id="task-agent"
                name="agentId"
                required
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full rounded-lg border border-rule bg-hover px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
              <label className="mb-1 block text-xs text-ink-3" htmlFor="task-priority">
                Priority
              </label>
              <select
                id="task-priority"
                name="priority"
                defaultValue="medium"
                className="w-full rounded-lg border border-rule bg-hover px-3 py-2 text-sm text-ink focus:border-ink-3 focus:outline-none"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          {selectedAgent?.telegramBotToken && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                name="sendViaTelegram"
                value="true"
                className="rounded border border-rule bg-hover accent-white"
              />
              Send result via Telegram
            </label>
          )}

          <div className="flex gap-2 pt-1">
            <PrimaryButton variant="ink" type="submit" disabled={isPending}>
              {isPending ? 'Sending…' : 'New task'}
            </PrimaryButton>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-rule px-4 py-2 text-sm font-medium text-ink-3 hover:border-rule-2"
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
