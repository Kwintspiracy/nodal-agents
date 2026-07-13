'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createWebhookTriggerAction, type AgentRow } from '@/lib/actions.ts';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { composeWebhookUrl } from './webhook-url.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import Select from '@/components/ui/Select';

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
        <PrimaryButton variant="ink" onClick={handleDone}>
          Done
        </PrimaryButton>
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
        <Select
          id="webhook-agent"
          label="Agent"
          name="agentId"
          required
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">Select…</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <TextInput
          id="webhook-name"
          label="Name"
          name="name"
          required
          placeholder="GitHub PR opened"
        />
      </div>

      <div>
        <TextArea
          id="webhook-task"
          label="Task template"
          name="taskTemplate"
          required
          rows={4}
          placeholder="A new pull request was opened: {pull_request.title}"
        />
        <p className="mt-1 text-xs text-ink-3">
          Use {'{field.subfield}'} to inject data from the incoming JSON payload (e.g.{' '}
          {'{pull_request.title}'}).
        </p>
      </div>

      <div className="flex gap-2 pt-1">
        <PrimaryButton variant="ink" type="submit" disabled={isPending}>
          {isPending ? 'Creating…' : 'Create webhook'}
        </PrimaryButton>
        <PrimaryButton variant="neutral" onClick={() => onOpenChange(false)}>
          Cancel
        </PrimaryButton>
      </div>
    </form>
  );
}
