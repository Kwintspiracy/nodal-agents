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
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={isPending}
        className="inline-flex h-[30px] items-center gap-1.5 rounded-md border border-rule px-3 text-[13px] font-medium leading-none text-ink-3 transition-colors hover:border-warn/60 hover:bg-warn-bg hover:text-warn disabled:cursor-not-allowed disabled:opacity-50"
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
