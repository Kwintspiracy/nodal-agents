'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { createWebhookTriggerAction, type AgentRow } from '@/lib/actions.ts';
import { SetUrl } from '@/components/ui/SetUrl.tsx';
import { composeWebhookUrl } from './webhook-url.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import Modal, { ModalFooter } from '@/components/ui/Modal';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import Select from '@/components/ui/Select';
import NotifyChannelFields from './NotifyChannelFields.tsx';

interface Props {
  agents: AgentRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lifts the freshly-minted secret up so the matching list row can also
   *  reveal it this session (see AutomationsClient's revealedWebhooks map). */
  onCreated: (id: string, revealed: { secret: string; path: string }) => void;
}

/**
 * WebhookForm — create-only (no edit mode: task_template/agent/notify changes
 * are simple enough to redo as delete+recreate, and editing would reopen the
 * "did the secret change" question for no reason). On success it swaps to a
 * success panel showing the full URL once, since the secret is never shown
 * again outside a rotate.
 *
 * Notify toggle + channel select (B2, notify-channel-choice plan) reuse
 * NotifyChannelFields — same mechanic as ScheduleForm's, since the runner
 * resolves a webhook trigger's owner conversation the exact same way a
 * schedule does (routes/webhook.ts, mirroring run-schedules.ts).
 */
export default function WebhookForm({ agents, open, onOpenChange, onCreated }: Props) {
  const [isPending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState('');
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(false);
  // '' = Auto (null on the wire) — native <select> values are always strings.
  const [notifyChannel, setNotifyChannel] = useState('');
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
        notifyOnSuccess,
        notifyChannel: notifyChannel || null,
      });
      if (!r.ok) toast.error(r.message);
      else {
        onCreated(r.data.id, { secret: r.data.secret, path: r.data.path });
        setSuccessUrl(composeWebhookUrl(r.data.path));
        toast.success('Webhook created');
        form.reset();
        setAgentId('');
        setNotifyOnSuccess(false);
        setNotifyChannel('');
      }
    });
  }

  function handleDone() {
    setSuccessUrl(null);
    onOpenChange(false);
  }

  // The Modal owns the panel chrome, header and footer (title/footer props) —
  // this component only supplies the body content and the footer's buttons.
  // The submit button lives in the Modal footer, OUTSIDE the <form> element,
  // so it targets the form via the HTML `form` attribute.
  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      dismissable={false}
      className="max-w-xl"
      title={successUrl ? 'Webhook created' : 'New webhook'}
      footer={
        successUrl ? (
          <ModalFooter>
            <PrimaryButton variant="ink" onClick={handleDone}>
              Done
            </PrimaryButton>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <PrimaryButton variant="neutral" onClick={() => onOpenChange(false)}>
              Cancel
            </PrimaryButton>
            <PrimaryButton variant="ink" type="submit" form="webhook-create-form" disabled={isPending}>
              {isPending ? 'Creating…' : 'Create webhook'}
            </PrimaryButton>
          </ModalFooter>
        )
      }
    >
      {successUrl ? (
        <div className="space-y-3">
          <SetUrl subtitle="Webhook URL" url={successUrl} />
          <p className="text-xs text-ink-3">
            Paste this URL into the service that should notify this agent. It contains the secret:
            treat it like a password.
          </p>
        </div>
      ) : (
        <form id="webhook-create-form" onSubmit={handleSubmit} className="space-y-3">
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

          <NotifyChannelFields
            idPrefix="webhook"
            agentId={agentId}
            agentName={agents.find((a) => a.id === agentId)?.name}
            notifyOnSuccess={notifyOnSuccess}
            onNotifyOnSuccessChange={setNotifyOnSuccess}
            notifyChannel={notifyChannel}
            onNotifyChannelChange={setNotifyChannel}
          />
        </form>
      )}
    </Modal>
  );
}
