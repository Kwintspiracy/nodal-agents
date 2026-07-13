'use client';

// CancelJobButton — flips a non-terminal job to 'cancelled' via the
// dashboard action. Used on the job-detail page next to the StatusPill.
//
// The runner observes the status flip cooperatively between LLM turns
// (apps/runner/src/job/execute.ts) — current in-flight LLM call finishes
// naturally, then the loop bails out at the next checkpoint.
//
// Hidden entirely for jobs that are already terminal (completed / failed /
// cancelled) — the parent decides via `canCancel` rather than this component
// fetching status, so server-rendered pages don't ship a button that's
// useless on hydration.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import { cancelJobAction } from '@/lib/actions.ts';

interface Props {
  jobId: string;
}

export default function CancelJobButton({ jobId }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    setOpen(false);
    startTransition(async () => {
      const r = await cancelJobAction(jobId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('Job cancelled');
      // Force a refresh so the StatusPill picks up the new status from
      // the server — revalidatePath ran in the action but the client
      // needs a re-render to consume it.
      router.refresh();
    });
  }

  return (
    <>
      <RowActionButton tone="danger" onClick={() => setOpen(true)} disabled={isPending}>
        {isPending ? 'Cancelling…' : 'Cancel'}
      </RowActionButton>
      <ConfirmDialog
        open={open}
        title="Cancel this job?"
        message="In-flight LLM turns will finish naturally — the loop bails at the next checkpoint. Use this to stop a job that's pending, awaiting, or stuck mid-execution."
        confirmLabel="Cancel job"
        cancelLabel="Keep running"
        destructive
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
