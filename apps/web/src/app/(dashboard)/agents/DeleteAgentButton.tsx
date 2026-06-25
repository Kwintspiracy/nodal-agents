'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash } from '@phosphor-icons/react';
import type { ActionResult } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

export default function DeleteAgentButton({
  id,
  name,
  deleteAction,
}: {
  id: string;
  name: string;
  deleteAction: (id: string) => Promise<ActionResult<void>>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const result = await deleteAction(id);
      if (!result.ok) {
        toast.error(result.message);
      } else {
        toast.success('Agent deleted');
        // Re-fetch the /agents list so the row disappears without a reload.
        router.refresh();
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
        aria-label="Delete"
        title="Delete"
        className="inline-flex items-center gap-1.5 rounded-lg border border-rule-2 px-2.5 py-1.5 text-xs font-medium text-ink-3 transition-colors hover:border-err hover:text-err disabled:opacity-50 sm:px-3"
      >
        <Trash size={15} className="sm:hidden" />
        <span className="hidden sm:inline">{isPending ? 'Deleting…' : 'Delete'}</span>
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete agent "${name}"?`}
        message="The agent and its assignments will be removed. Past job history is preserved."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
