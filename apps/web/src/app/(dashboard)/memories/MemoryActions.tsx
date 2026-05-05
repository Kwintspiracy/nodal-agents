'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  archiveMemoryAction,
  unarchiveMemoryAction,
  deleteMemoryAction,
} from '@/lib/actions.ts';
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
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleArchive}
          disabled={isPending}
          className="px-2.5 py-1 text-xs font-medium border border-neutral-800 text-neutral-400 rounded-md hover:border-neutral-700 hover:text-white transition-colors disabled:opacity-40"
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          className="px-2.5 py-1 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 transition-colors disabled:opacity-40"
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
