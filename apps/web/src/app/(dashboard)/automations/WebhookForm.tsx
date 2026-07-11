'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createWebhookTriggerAction, type AgentRow } from '@/lib/actions.ts';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { composeWebhookUrl } from './webhook-url.ts';

interface Props {
  agents: AgentRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lifts the freshly-minted secret up so the matching list row can also
   *  reveal it this session (see AutomationsClient's revealedWebhooks map). */
  onCreated: (id: string, revealed: { secret: string; path: string }) => void;
}

/**
 * WebhookForm — create-only (no edit mode: task_template/agent changes are
 * simple enough to redo as delete+recreate, and editing would reopen the
 * "did the secret change" question for no reason). On success it swaps to a
 * success panel showing the full URL once, since the secret is never shown
 * again outside a rotate.
 */
export default function WebhookForm({ agents, open, onOpenChange, onCreated }: Props) {
  const [isPending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState('');
  const [successUrl, setSuccessUrl] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    startTransition(async () => {
      const r = await createWebhookTriggerAction({
        agentId,
        name: fd.get('name'),
        taskTemplate: fd.get('taskTemplate'),
      });
      if (!r.ok) toast.error(r.message);
      else {
        onCreated(r.data.id, { secret: r.data.secret, path: r.data.path });
        setSuccessUrl(composeWebhookUrl(r.data.path));
        toast.success('Webhook created');
        form.reset();
        setAgentId('');
      }
    });
  }

  function handleDone() {
    setSuccessUrl(null);
    onOpenChange(false);
  }

  if (!open) return null;

  if (successUrl) {
    return (
      <div className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5">
        <h3 className="text-sm font-semibold text-ink">Webhook created</h3>
        <SetUrl subtitle="Webhook URL" url={successUrl} />
        <p className="text-xs text-ink-3">
          Paste this URL into the service that should notify this agent. It contains the secret —
          treat it like a password.
        </p>
        <button
          type="button"
          onClick={handleDone}
          className="inline-flex h-[34px] items-center rounded-md border-0 bg-ink px-3.5 text-[14px] font-medium leading-none text-canvas transition-[filter] hover:brightness-[0.92]"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-rule-2 bg-paper p-5"
    >
      <h3 className="text-sm font-semibold text-ink">New webhook</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-ink-3" htmlFor="webhook-agent">
            Agent
          </label>
          <select
            id="webhook-agent"
            name="agentId"
            required
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
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
          <label className="mb-1 block text-xs text-ink-3" htmlFor="webhook-name">
            Name
          </label>
          <input
            id="webhook-name"
            name="name"
            required
            placeholder="GitHub PR opened"
            className="w-full rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink placeholder-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-ink-3" htmlFor="webhook-task">
          Task template
        </label>
        <textarea
          id="webhook-task"
          name="taskTemplate"
          required
          rows={4}
          placeholder="A new pull request was opened: {pull_request.title}"
          className="w-full resize-y rounded-md border border-rule bg-canvas px-2 py-1.5 text-sm text-ink placeholder-ink-4 focus:border-ink-3 focus:outline-none"
        />
        <p className="mt-1 text-xs text-ink-3">
          Use {'{field.subfield}'} to inject data from the incoming JSON payload (e.g.{' '}
          {'{pull_request.title}'}).
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-md border-0 bg-ink px-3.5 text-[14px] font-medium leading-none text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create webhook'}
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="inline-flex h-[34px] items-center rounded-md border border-rule-2 px-3.5 text-[14px] font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
