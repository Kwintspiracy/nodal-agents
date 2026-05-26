'use client';

// CancelJobButton — flips a non-terminal job to 'cancelled' via the
// dashboard action. Used on the job-detail page next to the StatusBadge.
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
      // Force a refresh so the StatusBadge picks up the new status from
      // the server — revalidatePath ran in the action but the client
      // needs a re-render to consume it.
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={isPending}
        className="px-3 py-1.5 text-xs font-medium border border-neutral-700 hover:border-red-700 hover:bg-red-950/40 hover:text-red-300 text-neutral-300 rounded-md transition-colors disabled:opacity-50"
      >
        {isPending ? 'Cancelling…' : 'Cancel'}
      </button>
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
