'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { archiveMemoryAction, unarchiveMemoryAction, deleteMemoryAction } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  id: string;
  archived: boolean;
}

export default function MemoryActions({ id, archived }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleArchive() {
    startTransition(async () => {
      const action = archived ? unarchiveMemoryAction : archiveMemoryAction;
      const r = await action(id);
      if (!r.ok) toast.error(r.message);
      else toast.success(archived ? 'Memory restored' : 'Memory archived');
    });
  }

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteMemoryAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Memory deleted');
    });
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={handleArchive}
          disabled={isPending}
          className="rounded-md border border-rule-2 px-2.5 py-1 text-[11.5px] font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-40"
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          className="rounded-md border border-err/30 px-2.5 py-1 text-[11.5px] font-medium text-err transition-colors hover:border-err/60 hover:brightness-110 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete memory?"
        message="This memory will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
