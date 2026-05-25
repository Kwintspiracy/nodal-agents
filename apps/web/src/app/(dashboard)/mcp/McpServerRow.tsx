'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  deleteMcpServerAction,
  renameMcpServerAction,
  type McpServerInstance,
} from '@/lib/actions.ts';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';

interface Props {
  instance: McpServerInstance;
  /** Catalog label for the slug (e.g. "Cogni Cortex"). Falls back to instance.name. */
  catalogLabel: string;
  description: string;
}

export default function McpServerRow({ instance, catalogLabel, description }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(instance.name);

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteMcpServerAction(instance.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(`${instance.name} disconnected`);
    });
  }

  function performRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === instance.name) {
      setIsRenaming(false);
      return;
    }
    startTransition(async () => {
      const r = await renameMcpServerAction(instance.id, trimmed);
      if (!r.ok) {
        toast.error(r.message);
      } else {
        toast.success('Renamed');
        setIsRenaming(false);
      }
    });
  }

  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Instance name — inline rename */}
          {isRenaming ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') performRename();
                  if (e.key === 'Escape') {
                    setRenameValue(instance.name);
                    setIsRenaming(false);
                  }
                }}
                className="bg-neutral-800 border border-neutral-600 rounded-md px-2 py-1 text-sm text-white focus:border-neutral-400 focus:outline-none w-full max-w-xs"
              />
              <button
                type="button"
                onClick={performRename}
                disabled={isPending}
                className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameValue(instance.name);
                  setIsRenaming(false);
                }}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white font-medium">{instance.name}</span>
              <button
                type="button"
                onClick={() => setIsRenaming(true)}
                aria-label="Rename MCP server"
                className="text-neutral-600 hover:text-neutral-400 transition-colors text-xs leading-none"
                title="Rename"
              >
                ✎
              </button>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 font-mono">
                {catalogLabel}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                connected
              </span>
            </div>
          )}
          {description && <p className="text-xs text-neutral-500 mt-0.5">{description}</p>}
          <p className="text-xs text-neutral-600 mt-1">
            {instance.toolCount} tool{instance.toolCount === 1 ? '' : 's'} discovered
            {instance.apiKeyLast4 ? ` · key …${instance.apiKeyLast4}` : ''}
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
        title={`Disconnect "${instance.name}"?`}
        message="The MCP connector and all its agent assignments will be removed. Re-connecting later requires the API key again."
        confirmLabel="Disconnect"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
