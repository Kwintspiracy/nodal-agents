'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
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
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
        className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-500 rounded-lg hover:border-red-800/60 hover:text-red-400 transition-colors disabled:opacity-50"
      >
        {isPending ? 'Deleting…' : 'Delete'}
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
