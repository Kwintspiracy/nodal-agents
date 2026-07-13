'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from '@phosphor-icons/react';
import { sendTaskAction } from '@/lib/actions.ts';
import type { AgentRow } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import TextArea from '@/components/ui/TextArea';
import Select from '@/components/ui/Select';
import Checkbox from '@/components/ui/Checkbox';

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
      toast.success('Task sent, job created');
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

      <Modal open={open} onClose={() => setOpen(false)} title="New task" dismissable={false}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-ink-3" htmlFor="task-prompt">
              Task description
            </label>
            <TextArea
              id="task-prompt"
              name="prompt"
              required
              rows={6}
              placeholder="Summarise the last 10 emails from my inbox…"
              className="min-h-[80px] rounded-lg"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-ink-3" htmlFor="task-agent">
                Assign to
              </label>
              <Select
                id="task-agent"
                name="agentId"
                required
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="rounded-lg"
              >
                <option value="" disabled>
                  Select agent
                </option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.slug})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-3" htmlFor="task-priority">
                Priority
              </label>
              <Select
                id="task-priority"
                name="priority"
                defaultValue="medium"
                className="rounded-lg"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </div>
          </div>

          {selectedAgent?.telegramBotToken && (
            <Checkbox
              name="sendViaTelegram"
              value="true"
              label="Send result via Telegram"
              className="bg-hover"
            />
          )}

          <ModalFooter className="-mx-6 -mb-6 mt-2 rounded-b-xl">
            <PrimaryButton variant="neutral" type="button" onClick={() => setOpen(false)}>
              Cancel
            </PrimaryButton>
            <PrimaryButton variant="ink" type="submit" disabled={isPending}>
              {isPending ? 'Sending…' : 'New task'}
            </PrimaryButton>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}
