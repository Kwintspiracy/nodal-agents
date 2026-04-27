'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import type { ActionResult } from '@/lib/actions.ts';

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

  function handleClick() {
    if (!confirm(`Delete agent "${name}"?`)) return;
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
    <button
      onClick={handleClick}
      disabled={isPending}
      className="px-3 py-1.5 text-xs font-medium border border-neutral-800 text-neutral-500 rounded-lg hover:border-red-800/60 hover:text-red-400 transition-colors disabled:opacity-50"
    >
      {isPending ? 'Deleting…' : 'Delete'}
    </button>
  );
}
