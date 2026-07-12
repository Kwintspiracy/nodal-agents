'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash } from '@phosphor-icons/react';
import type { ActionResult } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';

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
      <RowActionButton
        square
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
        icon={<Trash size={16} />}
        tone="danger"
        title={isPending ? 'Deleting…' : 'Delete'}
      />
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
