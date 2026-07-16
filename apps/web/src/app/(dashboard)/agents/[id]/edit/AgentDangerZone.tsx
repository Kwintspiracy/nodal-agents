'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ActionResult } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton';

/**
 * AgentDangerZone — the Settings tab's bottom "danger zone", the only place
 * an agent can be deleted from now. Moved here from the /agents list (that
 * page dropped its per-row Delete — see AgentsList.tsx) per Quentin's
 * redesign: the list is browse/organize, the edit page is where destructive
 * action lives, mirroring "Delete/Disconnect always last, never a kebab".
 *
 * Reuses deleteAgentAction + ConfirmDialog exactly as the old list-row
 * DeleteAgentButton did — same action, same dialog — just a full-width
 * section instead of an icon-only row button, and it navigates to /agents
 * on success since this page is deleting the very agent it's showing.
 */
export default function AgentDangerZone({
  agentId,
  name,
  deleteAction,
}: {
  agentId: string;
  name: string;
  deleteAction: (id: string) => Promise<ActionResult<void>>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await deleteAction(agentId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('Agent deleted');
      router.push('/agents');
    });
  }

  return (
    <div className="rounded-2xl border border-err/30 bg-paper p-6">
      <div className="text-mono-11 uppercase tracking-[0.12em] text-err">Danger zone</div>
      <div className="mt-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="text-medium-14 text-ink">Delete this agent</p>
          <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3">
            Its jobs, schedules and memory go with it. This cannot be undone.
          </p>
        </div>
        <PrimaryButton
          variant="danger"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          className="shrink-0"
        >
          {isPending ? 'Deleting…' : 'Delete'}
        </PrimaryButton>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Delete agent "${name}"?`}
        message="This permanently removes the agent along with its jobs, schedules and memory."
        confirmLabel="Delete"
        destructive
        typeToConfirm={name}
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
