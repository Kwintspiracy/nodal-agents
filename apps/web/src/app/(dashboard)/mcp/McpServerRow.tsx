'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { deleteMcpServerAction, type McpServerListEntry } from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  /** A catalog entry whose `server` is non-null (a connected MCP server). */
  entry: McpServerListEntry;
}

export default function McpServerRow({ entry }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const server = entry.server;
  if (!server) return null;

  function performDelete() {
    if (!server) return;
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteMcpServerAction(server.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${entry.label} disconnected`);
      router.refresh();
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-medium">{entry.label}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
              connected
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">{entry.description}</p>
          <p className="text-xs text-neutral-600 mt-1">
            {server.toolCount} tool{server.toolCount === 1 ? '' : 's'} discovered
            {server.apiKeyLast4 ? ` · key …${server.apiKeyLast4}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          className="shrink-0 px-2.5 py-1 text-xs font-medium border border-red-900/40 text-red-400 rounded-md hover:border-red-700 hover:text-red-300 disabled:opacity-40"
        >
          Disconnect
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Disconnect "${entry.label}"?`}
        message="The MCP connector and all its agent assignments will be removed. Re-connecting later requires the API key again."
        confirmLabel="Disconnect"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
